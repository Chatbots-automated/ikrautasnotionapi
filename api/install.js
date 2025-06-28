/*  api/addMedia.js  – CommonJS, Node 18+  */
const { Client: Notion } = require('@notionhq/client');
const PQueue             = require('p-queue').default;
const path               = require('path');

// ── ENV ────────────────────────────────────────────
const MONDAY       = process.env.MONDAY_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;

// ── clients ────────────────────────────────────────
const notion = new Notion({ auth: NOTION_TOKEN });
const queue  = new PQueue({ concurrency: 3 });      // 3 parallel downloads

// ── helpers ────────────────────────────────────────
function mimeFromName(name) {
  const ext = path.extname(name).toLowerCase();
  return ext === '.mp4'          ? 'video/mp4'
       : ext === '.png'          ? 'image/png'
       : ext === '.jpg' || ext === '.jpeg'
                                 ? 'image/jpeg'
       : ext === '.pdf'          ? 'application/pdf'
       : 'application/octet-stream';
}

// trims to 100 chars (Notion limit)
function trimName(name) {
  return name.length <= 100 ? name : name.slice(0, 97) + '...';
}

async function getItemAssets(id) {
  console.log(`[Monday] Fetch item ${id}`);
  const query = `query ($id:[ID!]) {
    items(ids:$id) {
      assets { id name public_url file_size }
    }
  }`;
  const resp  = await fetch('https://api.monday.com/v2', {
    method : 'POST',
    headers: { 'Content-Type':'application/json', Authorization: MONDAY },
    body   : JSON.stringify({ query, variables:{ id:[String(id)] } })
  }).then(r => r.json());

  if (resp.errors) throw new Error(resp.errors[0].message);
  const assets = resp.data.items[0].assets || [];
  console.log(`[Monday] ${assets.length} asset(s)`);
  return assets;
}

async function uploadToNotion(buf, origName) {
  const name = trimName(origName);
  const mime = mimeFromName(name);

  const create = await fetch('https://api.notion.com/v1/file_uploads', {
    method : 'POST',
    headers : {
      Authorization   : `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type'  : 'application/json'
    },
    body: JSON.stringify({ mode:'single_part', filename:name, content_type:mime })
  }).then(r => r.json());

  await fetch(create.upload_url, {
    method : 'POST',
    headers: { 'Content-Type': mime },
    body   : buf
  });

  return { id: create.id, name };
}

// ── handler ────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end('POST only');

  const itemId = Number(req.body.itemId);
  const pageId = req.body.pageId;
  if (!itemId || !pageId) {
    return res.status(400).json({ ok:false, msg:'itemId or pageId missing' });
  }

  try {
    const assets   = await getItemAssets(itemId);
    const newFiles = [];

    await Promise.all(assets.map(a => queue.add(async () => {
      console.log(`[DL] ${a.name}`);
      const resp = await fetch(a.public_url);
      const buf  = Buffer.from(await resp.arrayBuffer());

      if (buf.length <= 20 * 1024 * 1024) {
        const { id, name } = await uploadToNotion(buf, a.name);
        newFiles.push({ name, type:'file_upload', file_upload:{ id } });
      } else {
        console.log(`[Skip] ${a.name} >20 MB – external link`);
        newFiles.push({ name: trimName(a.name), type:'external', external:{ url:a.public_url } });
      }
    })));

    // merge with existing files
    const page      = await notion.pages.retrieve({ page_id: pageId });
    const existing  = page.properties.files?.files || [];
    const merged    = [...existing, ...newFiles];

    await notion.pages.update({
      page_id: pageId,
      properties:{ files:{ files: merged } }
    });

    await notion.blocks.children.append({
      block_id: pageId,
      children: newFiles.map(f => ({
        object:'block',
        type : f.name.match(/\.mp4$/i) ? 'video' : 'image',
        ...(f.name.match(/\.mp4$/i) ? { video:f } : { image:f })
      }))
    });

    res.status(200).json({ ok:true, added:newFiles.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:e.message });
  }
};
