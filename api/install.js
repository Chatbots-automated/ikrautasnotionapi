/*  api/addMedia.js  – CommonJS, Node 18 on Vercel  */
const { Client: Notion } = require('@notionhq/client');
const PQueue             = require('p-queue').default;
const path               = require('path');

/* ── ENV ────────────────────────────────────────── */
const { MONDAY_TOKEN, NOTION_TOKEN } = process.env;

/* fetch() shim for Node 18  */
const fetch = (...a) => import('node-fetch').then(m => m.default(...a));

/* ── clients ────────────────────────────────────── */
const notion = new Notion({ auth: NOTION_TOKEN });
const queue  = new PQueue({ concurrency: 3 });   // 3 parallel downloads

/* ── helpers ────────────────────────────────────── */
const isVideo  = name => path.extname(name).toLowerCase() === '.mp4';
const isImage  = name =>
  ['.jpg','.jpeg','.png','.gif','.webp','.tif','.tiff'].includes(
    path.extname(name).toLowerCase()
  );
const trim100  = n => (n.length <= 100 ? n : n.slice(0,97) + '…');

/* pull Monday-com assets for a single item */
async function mondayAssets(id) {
  const query = `
    query ($id:[ID!]) {
      items(ids:$id) { assets { id name public_url file_size } }
    }`;
  const r = await fetch('https://api.monday.com/v2', {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      Authorization  : MONDAY_TOKEN
    },
    body   : JSON.stringify({ query, variables:{ id:[String(id)] } })
  }).then(r => r.json());

  if (r.errors) throw Error(r.errors[0].message);
  return r.data.items[0]?.assets || [];
}

/* build the minimal block Notion expects for an external file */
function blockForExternal(asset) {
  const base = {
    type    : 'external',
    external: { url: asset.public_url }
  };

  const blockType =
    isVideo(asset.name) ? 'video' :
    isImage(asset.name) ? 'image' : 'file';

  return {
    object: 'block',
    type  : blockType,
    [blockType]: base
  };
}

/* ── handler ────────────────────────────────────── */
module.exports = async (req, res) => {
  if (req.method !== 'POST')
    return res.status(405).end('POST only');

  const { itemId, pageId } = req.body;
  if (!itemId || !pageId)
    return res.status(400).json({ ok:false, msg:'itemId or pageId missing' });

  try {
    console.log(`[Monday] fetching assets for item ${itemId}`);
    const assets = await mondayAssets(itemId);

    const children = [];
    await Promise.all(
      assets.map(a => queue.add(async () => {
        console.log(`[Link] ${a.name}`);
        children.push(blockForExternal({ ...a, name: trim100(a.name) }));
      }))
    );

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
