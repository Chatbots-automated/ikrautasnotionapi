/*  api/notionToMonday.js  – CommonJS, Node 18 on Vercel  */
const { Client: Notion } = require('@notionhq/client');
const PQueue   = require('p-queue').default;
const path     = require('path');
const FormData = require('form-data');

const notion   = new Notion({ auth: process.env.NOTION_TOKEN });
const MONDAY   = process.env.MONDAY_TOKEN;
const BOARD_ID = process.env.MONDAY_BOARD_ID;
const URL_COL  = process.env.TEXT_COLUMN_ID;   // monday text column storing the Notion page URL
const FILE_COL = process.env.FILES_COLUMN_ID;  // monday “files” column to push media into
const queue    = new PQueue({ concurrency: 3 });

/* fetch() shim for Node 18 on Vercel Runtime */
const fetch = (...a) => import('node-fetch').then(m => m.default(...a));

/* tiny in-memory cache so we don’t send the same block twice on warm runs */
const SEEN = new Set();

/* trivial mime helper */
const mime = n => ({
  '.mp4':'video/mp4', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif',  '.webp':'image/webp', '.pdf':'application/pdf'
}[path.extname(n).toLowerCase()] || 'application/octet-stream');

/* ─────────────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  if (req.method === 'HEAD') return res.status(200).end();   // Notion ping
  if (req.method !== 'POST')  return res.status(405).end('POST only');

  const evt = req.body;
  console.log('[Webhook] raw payload →', JSON.stringify(evt, null, 2));

  /* ── URL-verification handshake ── */
  if (evt.type === 'url_verification' || evt.challenge) {
    const challenge = evt.challenge || evt.data?.challenge;
    return res.status(200).json({ challenge });
  }

  /* only interested in page.content_updated */
  if (evt.type !== 'page.content_updated') return res.status(200).end('ignored');

  try {
    const pageId  = evt.entity.id;
    const pageObj = await notion.pages.retrieve({ page_id: pageId });
    const pageURL = pageObj.url;
    if (!pageURL) throw new Error('page.url missing');

    console.log('[Webhook] page url →', pageURL);

    /* locate the monday item that has this URL in TEXT column */
    const itemId = await findMondayItem(pageURL);
    if (!itemId) {
      console.log('[Monday] no item stores that URL – done');
      return res.status(200).end('no monday row');
    }
    console.log('[Monday] matched item id →', itemId);

    /* fetch blocks */
    const { results } = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });

    const media = results.filter(b => {
      const ok = ['image','video','file','pdf','audio'].includes(b.type);
      return ok && !SEEN.has(b.id);
    });

    console.log(`[Notion] fresh media count → ${media.length}`);
    if (!media.length) return res.status(200).end('nothing new');

    media.forEach(b => {
      SEEN.add(b.id);
      const d = b[b.type];
      console.log(`   ↳ [${b.id}] type=${b.type} src=${d.external?.url || d.file?.url || d.file_upload?.id}`);
    });

    await Promise.all(media.map(b => queue.add(() => uploadToMonday(itemId, b))));

    res.status(200).json({ ok:true, added: media.length });
  } catch (e) {
    console.error('[Error]', e);
    res.status(500).json({ ok:false, error: e.message });
  }
};

/* ── helper: match item by URL ── */
async function findMondayItem(url) {
  const query = `
    query ($v:[String]!) {
      items_page_by_column_values(
        board_id:${BOARD_ID},
        columns:[{column_id:"${URL_COL}", column_values:$v}],
        limit:1
      ){
        items { id }
      }
    }`;
  const r = await fetch('https://api.monday.com/v2', {
    method :'POST',
    headers:{ 'Content-Type':'application/json', Authorization: MONDAY },
    body   : JSON.stringify({ query, variables: { v: [url] } })
  }).then(r => r.json());

  if (r.errors) throw new Error(r.errors[0].message);
  return r.data.items_page_by_column_values.items[0]?.id;
}

/* ── helper: upload a single Notion media block to Monday ── */
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
  form.append('variables', JSON.stringify({ file: null }));
  form.append('file', buf, { filename, contentType: mime(filename) });

  const r = await fetch('https://api.monday.com/v2/file', {
    method :'POST',
    headers:{ Authorization: MONDAY },
    body   : form
  }).then(r => r.json());

  if (r.errors) throw new Error(r.errors[0].message);
  console.log(`[Monday] ✔ uploaded ${filename} (asset id ${r.data.add_file_to_column.id})`);
}
