/*  api/notionToMonday.js  – verbose + extra diagnostics  */
const { Client: Notion } = require('@notionhq/client');
const PQueue   = require('p-queue').default;
const FormData = require('form-data');
const path     = require('path');

const notion   = new Notion({ auth: process.env.NOTION_TOKEN });
const MONDAY   = process.env.MONDAY_TOKEN;
const BOARD_ID = Number(process.env.MONDAY_BOARD_ID);     // ← cast!
const URL_COL  = process.env.TEXT_COLUMN_ID;              // text_mksny6n5
const FILE_COL = process.env.FILES_COLUMN_ID;             // files
const queue    = new PQueue({ concurrency: 3 });
const fetch    = (...a) => import('node-fetch').then(m => m.default(...a));

const SEEN = new Set();

/* tiny MIME helper */
const mime = n => ({
  '.mp4':'video/mp4','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf'
}[path.extname(n).toLowerCase()] || 'application/octet-stream');

/* ─────────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  if (req.method === 'HEAD') return res.status(200).end();
  if (req.method !== 'POST')  return res.status(405).end('POST only');

  console.log('\n────────── New webhook @', new Date().toISOString(), '──────────');

  const evt = req.body;
  if (evt.type === 'url_verification' || evt.challenge)
    return res.status(200).json({ challenge: evt.challenge || evt.data?.challenge });

  if (evt.type !== 'page.content_updated') return res.status(200).end('ignored');

  try {
    /* 1️⃣  canonical Notion URL */
    const pageId  = evt.entity.id;
    const { url: pageURL } = await notion.pages.retrieve({ page_id: pageId });
    console.log('[Page] ', pageId, '→', pageURL);

    /* 2️⃣  try exact match in Monday */
    let itemId = await findMondayItem(pageURL, /*exact*/true);
    if (!itemId) {
      /* optional fallback: loose contains() */
      itemId = await findMondayItem(pageURL, /*exact*/false);
    }
    if (!itemId) return res.status(200).end('no monday row');

    console.log('[Match] Monday item', itemId);

    /* 3️⃣  collect media (depth-2 walker) */
    const media = [];
    await crawl(pageId, 0, media);
    const fresh = media.filter(b => !SEEN.has(b.id));
    fresh.forEach(b => SEEN.add(b.id));
    console.log(`[Media] discovered=${media.length}  new=${fresh.length}`);
    if (!fresh.length) return res.status(200).end('nothing new');

    await Promise.all(fresh.map(b => queue.add(() => upload(itemId, b))));
    res.status(200).json({ ok:true, added:fresh.length });
  } catch (err) {
    console.error('[Fatal]', err);
    res.status(500).json({ ok:false, error:err.message });
  }
};

/* ── recursive crawl (≤ depth 2) ── */
async function crawl(blockId, depth, out) {
  if (depth > 2) return;
  let cursor; let page = 0;
  do {
    const { results, next_cursor, has_more } =
      await notion.blocks.children.list({ block_id:blockId, start_cursor:cursor, page_size:100 });
    console.log(`[crawl] depth${depth} page${++page} children=${results.length}`);
    for (const b of results) {
      if (['image','video','file','pdf','audio'].includes(b.type)) out.push(b);
      if (b.has_children) await crawl(b.id, depth+1, out);
    }
    cursor = has_more ? next_cursor : undefined;
  } while (cursor);
}

/* ── Monday lookup ── */
async function findMondayItem(url, exact) {
  const value   = exact ? url : url.toLowerCase();
  const query   = `
    query($v:[String!]!) {
      items_page_by_column_values(
        board_id:${BOARD_ID},
        columns:[{column_id:"${URL_COL}", column_values:$v}],
        limit:100
      ){ items { id name column_values(ids:["${URL_COL}"]){ text } } }
    }`;
  console.log('[GQL] board', BOARD_ID, 'column', URL_COL, 'looking for', value);
  const resp = await fetch('https://api.monday.com/v2', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization:MONDAY },
    body:JSON.stringify({ query, variables:{ v:[value] } })
  }).then(r => r.json());

  if (resp.errors) { console.error('[GQL-error]', resp.errors); throw Error(resp.errors[0].message); }

  const hits = resp.data.items_page_by_column_values.items;
  if (!hits.length) return null;

  /* if loose search, return the first whose cell actually *contains* the full url */
  if (!exact) {
    const hit = hits.find(it => (it.column_values[0].text||'').toLowerCase().includes(value));
    return hit?.id || null;
  }
  return hits[0].id;
}

/* ── upload helper ── */
async function upload(itemId, block) {
  const data = block[block.type];
  const src  = data.file_upload?.id
      ? await notion.fileUploads.retrieve({ file_upload_id:data.file_upload.id }).then(r=>r.url)
      : data.file?.url || data.external?.url;

  if (!src) { console.warn('[skip] no url on', block.id); return; }

  const filename = path.basename(new URL(src).pathname) || `${block.id}.bin`;
  const buf      = Buffer.from(await (await fetch(src)).arrayBuffer());
  console.log(`[upload] ${filename}  ${(buf.length/1e6).toFixed(2)} MB`);

  const form = new FormData();
  form.append('query',`mutation($file:File!){add_file_to_column(item_id:${itemId},column_id:"${FILE_COL}",file:$file){id}}`);
  form.append('variables', JSON.stringify({ file:null }));
  form.append('file', buf, { filename, contentType:mime(filename) });

  const r = await fetch('https://api.monday.com/v2/file', {
    method:'POST', headers:{ Authorization:MONDAY }, body:form
  }).then(r=>r.json());

  if (r.errors){ console.error('[Monday-error]', r.errors); throw Error(r.errors[0].message); }
  console.log(`[✓] ${filename} → asset ${r.data.add_file_to_column.id}`);
}
