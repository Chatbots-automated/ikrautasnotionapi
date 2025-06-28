import { VercelRequest, VercelResponse } from '@vercel/node';
import { Client as Notion } from '@notionhq/client';
import fetch from 'node-fetch';
import PQueue from 'p-queue';

const notion  = new Notion({ auth: process.env.NOTION_TOKEN });
const DB_ID   = process.env.NOTION_DB!;
const BOT_ID  = process.env.BOT_ID!;
const MONDAY  = process.env.MONDAY_TOKEN!;

// Rate-limit helpers
const queue = new PQueue({ concurrency: 3 });          // 3 parallel fetches max
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));

/** get Monday item + assets */
async function getMondayItem(itemId:number) {
  const query = `query ($id:[Int]) {
    items(ids:$id) {
      name
      column_values { id text }
      assets { id public_url name mimetype file_size }
    }
  }`;
  const r = await fetch('https://api.monday.com/v2', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization:MONDAY },
    body: JSON.stringify({ query, variables:{ id:itemId } })
  }).then(r=>r.json());
  if (r.errors) throw new Error(r.errors[0].message);
  return r.data.items[0];
}

/** upload ≤20 MB file into Notion File Upload API */
async function uploadToNotion(buf:Buffer, name:string, mime:string){
  // step 1: create
  const create = await fetch('https://api.notion.com/v1/file_uploads', {
    method:'POST',
    headers:{
      Authorization:`Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version':'2022-06-28',
      'Content-Type':'application/json'
    },
    body: JSON.stringify({ mode:'single_part', filename:name, content_type:mime })
  }).then(r=>r.json());

  // step 2: send binary
  await fetch(create.upload_url, { method:'POST', headers:{ 'Content-Type':mime }, body: buf });

  return create.id;            // return file_upload_id
}

export default async function handler(req:VercelRequest,res:VercelResponse){
  if(req.method!=='POST') return res.status(405).end('POST only');
  const itemId = Number(req.body?.itemId);
  if(!itemId) return res.status(400).json({ ok:false, msg:'itemId missing' });

  try{
    /* 1 ── pull Monday data */
    const item = await getMondayItem(itemId);

    /* map a helper for column text */
    const col = (id:string)=>item.column_values.find((c:any)=>c.id===id)?.text ?? '';

    /* 2 ── fetch & transform every asset (dynamic) */
    const files: any[] = [];

    await Promise.all(item.assets.map(a => queue.add(async () =>{
      // throttle: Monday S3 links sometimes 403 if hammered
      const buf = await fetch(a.public_url).then(r=>r.buffer());

      let notionFile;
      if(buf.length <= 20*1024*1024){              // ≤20 MB
        const fid = await uploadToNotion(buf, a.name, a.mimetype);
        notionFile = { name:a.name, type:'file_upload', file_upload:{ id:fid } };
      }else{
        // big file stays external; still streams in Notion
        notionFile = { name:a.name, type:'external', external:{ url:a.public_url } };
      }
      files.push(notionFile);
      await sleep(200);                            // gentle on Monday CDN
    })));

    /* 3 ── create Notion page with attachments */
    const page = await notion.pages.create({
      parent:{ database_id:DB_ID },
      properties:{
        Title:   { title:[{ text:{ content:item.name } }] },
        Adresas: { rich_text:[{ text:{ content: col('address') } }] },
        Dates:   { date:{ start: col('date') } },
        Status:  { status:{ name:'backlog' } },
        People:  { people:[{ object:'user', id:BOT_ID }] },
        files:   { files }                        // every photo/video
      },
      // Optional: inline preview blocks
      children: files.map(f => ({
        object:'block',
        type:   f.name.match(/\.mp4$/i) ? 'video' : 'image',
        ...(f.name.match(/\.mp4$/i)
            ? { video: f } : { image: f })
      }))
    });

    res.status(200).json({ ok:true, url:page.url, attachments:files.length });
  }catch(err:any){
    console.error(err);
    res.status(500).json({ ok:false, error:err.message });
  }
}
