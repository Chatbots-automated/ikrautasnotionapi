import { VercelRequest, VercelResponse } from '@vercel/node';
import { Client as Notion } from '@notionhq/client';
import fetch from 'node-fetch';
import PQueue from 'p-queue';

const notion = new Notion({ auth: process.env.NOTION_TOKEN });
const MONDAY = process.env.MONDAY_TOKEN!;
const BOT_ID = process.env.BOT_ID!;           // fallback People value

const queue = new PQueue({ concurrency: 3 }); // polite download rate

/* ── helpers ───────────────────────────────────────────────────────── */

async function getItemAssets(itemId: number) {
  console.log(`[Monday] get item ${itemId}`);
  const q = `query ($id:[Int]){ items(ids:$id){ assets{ id public_url name mimetype file_size } }}`;
  const r = await fetch('https://api.monday.com/v2', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization:MONDAY },
    body: JSON.stringify({ query:q, variables:{ id:itemId } })
  }).then(r=>r.json());
  if(r.errors) throw new Error(r.errors[0].message);
  const item = r.data.items[0];
  console.log(`[Monday] ${item.assets.length} asset(s) found`);
  return item.assets;
}

async function uploadToNotion(buf:Buffer,name:string,mime:string){
  console.log(`[Notion] create upload ${name} ${(buf.length/1e6).toFixed(2)} MB`);
  const create = await fetch('https://api.notion.com/v1/file_uploads',{
    method:'POST',
    headers:{
      Authorization:`Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version':'2022-06-28',
      'Content-Type':'application/json'
    },
    body: JSON.stringify({ mode:'single_part', filename:name, content_type:mime })
  }).then(r=>r.json());

  await fetch(create.upload_url,{ method:'POST', headers:{ 'Content-Type':mime }, body:buf });
  console.log(`[Notion] uploaded ${create.id}`);
  return create.id;
}

/* ── handler ───────────────────────────────────────────────────────── */

export default async function handler(req:VercelRequest,res:VercelResponse){
  if(req.method!=='POST') return res.status(405).send('POST only');

  const { itemId, pageId } = req.body || {};
  const pulse = Number(itemId);
  if(!pulse || !pageId) return res.status(400).json({ ok:false, msg:'itemId or pageId missing' });

  try{
    const assets = await getItemAssets(pulse);
    const newFiles:any[] = [];

    await Promise.all(assets.map(a=> queue.add(async ()=>{
      console.log(`[DL] ${a.name}`);
      const buf = await fetch(a.public_url).then(r=>r.buffer());
      if(buf.length<=20*1024*1024){
        const fid = await uploadToNotion(buf,a.name,a.mimetype);
        newFiles.push({ name:a.name, type:'file_upload', file_upload:{ id:fid } });
      }else{
        console.log(`[SkipUpload] ${a.name} big, keep external`);
        newFiles.push({ name:a.name, type:'external', external:{ url:a.public_url } });
      }
    })));

    /* 1️⃣  merge into existing files property */
    console.log('[Notion] retrieving existing files property …');
    const page = await notion.pages.retrieve({ page_id: pageId });
    const existing = (page as any).properties.files?.files ?? [];
    const merged = [...existing, ...newFiles];

    console.log(`[Notion] updating files property with ${merged.length} total file(s)`);
    await notion.pages.update({
      page_id: pageId,
      properties:{ files:{ files: merged } }
    });

    /* 2️⃣  append preview blocks */
    console.log('[Notion] appending preview blocks …');
    await notion.blocks.children.append({
      block_id: pageId,
      children: newFiles.map(f=>({
        object:'block',
        type: f.name.match(/\.mp4$/i) ? 'video' : 'image',
        ...(f.name.match(/\.mp4$/i) ? { video:f } : { image:f })
      }))
    });

    console.log('[Done] media added');
    return res.status(200).json({ ok:true, added:newFiles.length });
  }catch(err:any){
    console.error('[ERROR]',err.message, err.stack);
    return res.status(500).json({ ok:false, error:err.message });
  }
}
