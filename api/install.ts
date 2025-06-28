const { Client: Notion }  = require('@notionhq/client');
const fetch               = require('node-fetch');
const PQueue              = require('p-queue').default;

const MONDAY = process.env.MONDAY_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB = process.env.NOTION_DB;
const BOT_ID = process.env.BOT_ID;

const notion = new Notion({ auth: NOTION_TOKEN });
const queue  = new PQueue({ concurrency: 3 });

async function getItemAssets (itemId) {
  console.log(`[Monday] fetch ${itemId}`);
  const query = `query ($id:[Int]){ items(ids:$id){ assets{ id public_url name mimetype file_size } }}`;
  const r = await fetch('https://api.monday.com/v2', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization: MONDAY },
    body: JSON.stringify({ query, variables:{ id: itemId } })
  }).then(r=>r.json());
  if (r.errors) throw new Error(r.errors[0].message);
  const a = r.data.items[0].assets;
  console.log(`[Monday] ${a.length} asset(s)`);
  return a;
}

async function upload(buf,name,mime){
  console.log(`[Notion] create upload for ${name}`);
  const create = await fetch('https://api.notion.com/v1/file_uploads',{
    method:'POST',
    headers:{
      Authorization:`Bearer ${NOTION_TOKEN}`,
      'Notion-Version':'2022-06-28',
      'Content-Type':'application/json'
    },
    body: JSON.stringify({mode:'single_part',filename:name,content_type:mime})
  }).then(r=>r.json());

  await fetch(create.upload_url,{method:'POST',headers:{'Content-Type':mime},body:buf});
  console.log(`[Notion] uploaded id=${create.id}`);
  return create.id;
}

module.exports = async (req,res)=>{
  if(req.method!=='POST'){ res.status(405).end('POST only'); return; }

  const itemId = Number(req.body.itemId);
  const pageId = req.body.pageId;
  if(!itemId||!pageId){ res.status(400).json({ok:false,msg:'itemId or pageId missing'}); return;}

  try{
    const assets = await getItemAssets(itemId);
    const newFiles = [];

    await Promise.all(assets.map(a=>queue.add(async ()=>{
      console.log(`[DL] ${a.name}`);
      const buf = await fetch(a.public_url).then(r=>r.buffer());
      if(buf.length<=20*1024*1024){
        const fid = await upload(buf,a.name,a.mimetype);
        newFiles.push({ name:a.name, type:'file_upload', file_upload:{ id:fid } });
      }else{
        console.log(`[Skip] big file keep external`);
        newFiles.push({ name:a.name, type:'external', external:{ url:a.public_url } });
      }
    })));

    /* merge with old files */
    const page = await notion.pages.retrieve({ page_id: pageId });
    const existing = (page.properties.files && page.properties.files.files) || [];
    const merged = [...existing, ...newFiles];

    await notion.pages.update({ page_id:pageId, properties:{ files:{ files: merged } }});
    await notion.blocks.children.append({
      block_id: pageId,
      children: newFiles.map(f=>({
        object:'block',
        type: f.name.match(/\.mp4$/i)?'video':'image',
        ...(f.name.match(/\.mp4$/i)?{video:f}:{image:f})
      }))
    });

    res.status(200).json({ok:true,added:newFiles.length});
  }catch(e){
    console.error(e);
    res.status(500).json({ok:false,error:e.message});
  }
};
