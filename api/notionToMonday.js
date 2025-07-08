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

/* ──────────────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  /* Notion will call HEAD every 5 minutes to keep the endpoint “warm”  */
  if (req.method === 'HEAD') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).end('POST only');

  /* Parse body (Vercel gives it to us as JSON already) */
  const evt = req.body;
  console.log('[Webhook] raw payload →', JSON.stringify(evt, null, 2));

  /* ── 1. URL-verification handshake ─────────────────────────────── */
  if (evt.type === 'url_verification' || evt.challenge) {
    const challenge = evt.challenge || evt.data?.challenge;
    console.log('[Webhook] answering challenge →', challenge);
    return res.status(200).json({ challenge });
  }

  /* ── 2. Ignore everything except content updates ───────────────── */
  if (evt.type !== 'page.content_updated') {
    console.log('[Webhook] non-content event, ignoring');
    return res.status(200).end('ignored');
  }

  try {
    /* ── 3. Get the page & its canonical URL ─────────────────────── */
    const pageId  = evt.entity.id;
    const pageObj = await notion.pages.retrieve({ page_id: pageId });
    const pageURL = pageObj.url;
    if (!pageURL) throw new Error('page.url missing on retrieve');

    console.log('[Webhook] page url →', pageURL);

    /* ── 4. Find the Monday item that stores this URL ─────────────── */
    const itemId = await findMondayItem(pageURL);
    if (!itemId) {
      console.log('[Monday] no item stores that URL – done');
      return res.status(200).end('no monday row');
    }
    console.log('[Monday] matched item id →', itemId);

    /* ── 5. Grab up to 100 child blocks (plenty for installers) ───── */
    const blocks = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100
    });

    /* ── 6. Pick NEW media blocks only ────────────────────────────── */
    const media = blocks.results.filter(b => {
      const ok = ['image','video','file','pdf','audio'].includes(b.type);
      return ok && !SEEN.has(b.id);
    });

    console.log(`[Notion] fresh media count → ${media.length}`);

    if (!media.length) return res.status(200).end('nothing new');

    /* mark + log */
    media.forEach(b => {
      SEEN.add(b.id);
      const d   = b[b.type];
      const src = d.external?.url || d.file?.url || d.file_upload?.id;
      console.log(`   ↳ [${b.id}] type=${b.type} src=${src}`);
    });

    /* ── 7. Ship them to Monday concurrently ─────────────────────── */
    await Promise.all(media.map(b => queue.add(() => uploadToMonday(itemId, b))));

    res.status(200).json({ ok: true, added: media.length });

  } catch (e) {
    console.error('[Error]', e);
    res.status(500).json({ ok:false, error: e.message });
  }
};

/* ──────────────────────────────────────────────────────────────────── */
/* Helper: find monday item whose URL column equals the Notion page */
async function findMondayItem(url) {
  const query = `
    query ($v:[String]!) {                                   /* ← non-null list */
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

/* ──────────────────────────────────────────────────────────────────── */
/* Helper: push ONE media block from Notion into Monday “files” col */
async function uploadToMonday(itemId, block) {

  /* 1. Resolve a one-hour download URL from the block -------------- */
  const data = block[block.type];
  const url  = data.file_upload?.id
      ? await notion.fileUploads
          .retrieve({ file_upload_id: data.file_upload.id })
          .then(r => r.url)
      : data.file?.url || data.external?.url;

  if (!url) throw new Error(`no url on block ${block.id}`);

  const filename = path.basename(new URL(url).pathname) || `${block.id}.bin`;
  const buf      = Buffer.from(await (await fetch(url)).arrayBuffer());

  console.log(`      · dl ${filename}  ${(buf.length / 1e6).toFixed(2)} MB`);

  /* 2. Build multipart/form-data mutation -------------------------- */
  const form = new FormData();
  form.append(
    'query',
    `mutation ($file: File!) {
       add_file_to_column(item_id:${itemId}, column_id:"${FILE_COL}", file:$file){ id }
     }`
  );
  form.append('variables', JSON.stringify({ file: null }));
  form.append('file', buf, { filename, contentType: mime(filename) });

  const r = await fetch('https://api.monday.com/v2/file', {
    method :'POST',
    headers:{ Authorization: MONDAY },
    body   : form
  }).then(r => r.json());

  if (r.errors) {
    console.error('[Monday error]', r.errors);
    throw new Error(r.errors[0].message);
  }

  console.log(`[Monday] ✔ uploaded ${filename} (asset id ${r.data.add_file_to_column.id})`);
}
