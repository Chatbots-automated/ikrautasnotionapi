/*  api/notionToMonday.js  – CommonJS, Node 18 on Vercel  */
const { Client: Notion } = require('@notionhq/client');
const PQueue   = require('p-queue').default;
const FormData = require('form-data');
const path     = require('path');

const notion   = new Notion({ auth: process.env.NOTION_TOKEN });
const MONDAY   = process.env.MONDAY_TOKEN;
const BOARD_ID = process.env.MONDAY_BOARD_ID;
const URL_COL  = process.env.TEXT_COLUMN_ID;   // text_mksny6n5
const FILE_COL = process.env.FILES_COLUMN_ID;  // files
const queue    = new PQueue({ concurrency: 3 });

const fetch = (...a) => import('node-fetch').then(m => m.default(...a));

/* in-memory cache so we don’t upload the same block twice */
const SEEN = new Set();

const mime = n => ({
  '.mp4':'video/mp4', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.webp':'image/webp', '.pdf':'application/pdf'
}[path.extname(n).toLowerCase()] || 'application/octet-stream');

/* ─────────────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  if (req.method === 'HEAD') return res.status(200).end();    // Notion ping
  if (req.method !== 'POST')  return res.status(405).end('POST only');

  const evt = req.body;
  console.log('[Webhook] raw payload →', JSON.stringify(evt, null, 2));

  /* URL-verification handshake */
  if (evt.type === 'url_verification' || evt.challenge)
    return res.status(200).json({ challenge: evt.challenge || evt.data?.challenge });

  if (evt.type !== 'page.content_updated') return res.status(200).end('ignored');

  try {
    /* 1️⃣  canonical URL */
    const pageId  = evt.entity.id;
    const page    = await notion.pages.retrieve({ page_id: pageId });
    const pageURL = page.url;
    if (!pageURL) throw new Error('page.url missing');
    console.log('[Webhook] page url →', pageURL);

    /* 2️⃣  Monday item lookup */
    const itemId  = await findMondayItem(pageURL);
    if (!itemId)  return res.status(200).end('no monday row');
    console.log('[Monday] matched item id →', itemId);

    /* 3️⃣  crawl blocks (depth-first, 3 levels deep, paginated) */
    const mediaBlocks = [];
    await crawlBlocks(pageId, 0, mediaBlocks);

    const fresh = mediaBlocks.filter(b => !SEEN.has(b.id));
    console.log(`[Notion] fresh media count → ${fresh.length}`);
    if (!fresh.length) return res.status(200).end('nothing new');

    fresh.forEach(b => {
      SEEN.add(b.id);
      const d = b[b.type];
      console.log(`   ↳ [${b.id}] ${b.type} src=${d.external?.url || d.file?.url || d.file_upload?.id}`);
    });

    /* 4️⃣  upload in parallel */
    await Promise.all(fresh.map(b => queue.add(() => uploadToMonday(itemId, b))));

    res.status(200).json({ ok:true, added: fresh.length });
  } catch (err) {
    console.error('[Error]', err);
    res.status(500).json({ ok:false, error: err.message });
  }
};

/* ── recursively walk up to 3 levels ── */
async function crawlBlocks(blockId, depth, outArr) {
  if (depth > 2) return;                          // safety guard
  let cursor = undefined;
  do {
    const { results, next_cursor, has_more } =
      await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });

    for (const b of results) {
      if (['image','video','file','pdf','audio'].includes(b.type)) outArr.push(b);
      /* dive into nested blocks (toggles, columns, call-outs, etc.) */
      if (b.has_children) await crawlBlocks(b.id, depth + 1, outArr);
    }
    cursor = has_more ? next_cursor : undefined;
  } while (cursor);
}

/* ── helper: look up the monday row by exact URL ── */
async function findMondayItem(url) {
  const query = `
    query ($v:[String]!) {
      items_page_by_column_values(
        board_id:${BOARD_ID},
        columns:[{column_id:"${URL_COL}", column_values:$v}],
        limit:1
      ){ items { id } }
    }`;
  const resp = await fetch('https://api.monday.com/v2', {
    method :'POST',
    headers:{ 'Content-Type':'application/json', Authorization: MONDAY },
    body   : JSON.stringify({ query, variables:{ v:[url] } })
  }).then(r => r.json());

  if (resp.errors) throw new Error(resp.errors[0].message);
  return resp.data.items_page_by_column_values.items[0]?.id || null;
}

/* ── helper: push ONE media block into Monday “files” column ── */
async function uploadToMonday(itemId, block) {
  const data = block[block.type];
  const url  = data.file_upload?.id
    ? await notion.fileUploads.retrieve({ file_upload_id: data.file_upload.id }).then(r => r.url)
    : data.file?.url || data.external?.url;
  if (!url) throw new Error(`no url on block ${block.id}`);

  const filename = path.basename(new URL(url).pathname) || `${block.id}.bin`;
  const buf      = Buffer.from(await (await fetch(url)).arrayBuffer());
  console.log(`      · dl ${filename} ${(buf.length/1e6).toFixed(2)} MB`);

  const form = new FormData();
  form.append('query', `
    mutation ($file: File!) {
      add_file_to_column(item_id:${itemId}, column_id:"${FILE_COL}", file:$file){ id }
    }`);
  form.append('variables', JSON.stringify({ file:null }));
  form.append('file', buf, { filename, contentType: mime(filename) });

  const resp = await fetch('https://api.monday.com/v2/file', {
    method :'POST',
    headers:{ Authorization: MONDAY },
    body   : form
  }).then(r => r.json());

  if (resp.errors) throw new Error(resp.errors[0].message);
  console.log(`[Monday] ✔ uploaded ${filename} (asset id ${resp.data.add_file_to_column.id})`);
}
