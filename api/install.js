/*  api/addMedia.js  – CommonJS, Node 18+  */
const { Client: Notion } = require('@notionhq/client');
const PQueue             = require('p-queue').default;
const path               = require('path');

/* ── ENV ───────────────────────────────────────── */
const { MONDAY_TOKEN, NOTION_TOKEN } = process.env;

/* fetch() for Node 18 on Vercel */
const fetch = (...a) => import('node-fetch').then(m => m.default(...a));

/* ── clients ───────────────────────────────────── */
const notion = new Notion({ auth: NOTION_TOKEN });
const queue  = new PQueue({ concurrency: 3 });           // polite parallelism

/* ── helpers ───────────────────────────────────── */
const mimeFromName = n => {
  const ext = path.extname(n).toLowerCase();
  return {
    '.mp4' : 'video/mp4',
    '.png' : 'image/png',
    '.jpg' : 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif' : 'image/gif',
    '.pdf' : 'application/pdf'
  }[ext] || 'application/octet-stream';
};

const trim = n => (n.length <= 100 ? n : n.slice(0, 97) + '…');

async function mondayAssets(id) {
  console.log(`[Monday] fetch assets for item ${id}`);
  const query = `
    query ($id:[ID!]) {
      items(ids:$id) { assets { id name public_url file_size } }
    }`;
  const r = await fetch('https://api.monday.com/v2', {
    method : 'POST',
    headers: { 'Content-Type':'application/json', Authorization: MONDAY_TOKEN },
    body   : JSON.stringify({ query, variables:{ id:[String(id)] } })
  }).then(r => r.json());

  if (r.errors) throw Error(r.errors[0].message);
  const list = r.data.items[0]?.assets || [];
  console.log(`[Monday] ${list.length} asset(s) found`);
  return list;
}

async function upload(buf, name) {
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

  if (create.object === 'error' || !create.upload_url) return null;

  await fetch(create.upload_url, {
    method : 'POST',
    headers: { 'Content-Type': mime },
    body   : buf
  });

  return { id: create.id, name };
}

/* ── handler ───────────────────────────────────── */
module.exports = async (req, res) => {
  if (req.method !== 'POST')
    return res.status(405).end('POST only');

  const { itemId, pageId } = req.body;
  if (!itemId || !pageId)
    return res.status(400).json({ ok:false, msg:'itemId or pageId missing' });

  try {
    const assets   = await mondayAssets(itemId);
    const children = [];

    await Promise.all(assets.map(a => queue.add(async () => {
      console.log(`[DL] ${a.name}`);
      const buf = Buffer.from(await (await fetch(a.public_url)).arrayBuffer());

      // try direct upload if ≤ 20 MB
      if (buf.length <= 20 * 1024 * 1024) {
        const up = await upload(buf, a.name);
        if (up) {
          children.push(blockForFile({
            type       : 'file_upload',
            file_upload: { id: up.id },
            name       : up.name              // will be stripped in blockForFile()
          }));
          return;
        }
      }

      // fallback – external link
      console.log(`[External] ${a.name}`);
      children.push(blockForFile({
        type   : 'external',
        external:{ url: a.public_url },
        name   : trim(a.name)                // will be stripped in blockForFile()
      }));
    })));

    // append every new block at once
    if (children.length) {
      await notion.blocks.children.append({
        block_id: pageId,
        children
      });
    }

    res.status(200).json({ ok:true, added: children.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error: err.message });
  }
};

/* ── build a Notion block from a file object ───── */
function blockForFile(file) {
  /* decide block type by extension */
  const ext      = (file.name || '').toLowerCase();
  const isVideo  = ext.endsWith('.mp4');
  const isImage  = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff'].some(e => ext.endsWith(e));
  const blockType = isVideo ? 'video' : isImage ? 'image' : 'file';

  /* Notion media blocks forbid `name` and require correct sub-object */
  const payload = { ...file };
  delete payload.name;              // ⚡ strip forbidden field

  return {
    object: 'block',
    type  : blockType,
    [blockType]: payload            // image / video / file
  };
}
