/*  api/notionToMonday.js  – CommonJS, Node 18 on Vercel  */
/*  “verbose” edition – lots of console.log() calls        */

const { Client: Notion } = require('@notionhq/client');
const PQueue   = require('p-queue').default;
const FormData = require('form-data');
const path     = require('path');

const notion   = new Notion({ auth: process.env.NOTION_TOKEN });
const MONDAY   = process.env.MONDAY_TOKEN;
const BOARD_ID = process.env.MONDAY_BOARD_ID;
const URL_COL  = process.env.TEXT_COLUMN_ID;         // text_mksny6n5
const FILE_COL = process.env.FILES_COLUMN_ID;        // files
const queue    = new PQueue({ concurrency: 3 });

const fetch = (...a) => import('node-fetch').then(m => m.default(...a));

/* De-dupe cache */
const SEEN = new Set();

/* Simple MIME map */
const mime = n => ({
  '.mp4':'video/mp4', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.webp':'image/webp', '.pdf':'application/pdf'
}[path.extname(n).toLowerCase()] || 'application/octet-stream');

/* ────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  if (req.method === 'HEAD') return res.status(200).end();   // Notion warm-up
  if (req.method !== 'POST')  return res.status(405).end('POST only');

  console.log('───────────────────────────────────────────────');
  console.log(`[Incoming] ${new Date().toISOString()}`);

  const evt = req.body;
  console.log('[Webhook] payload:', JSON.stringify(evt, null, 2));

  /* URL-verification handshake */
  if (evt.type === 'url_verification' || evt.challenge)
    return res.status(200).json({ challenge: evt.challenge || evt.data?.challenge });

  if (evt.type !== 'page.content_updated')
    return res.status(200).end('ignored');

  try {
    /* 1️⃣  fetch page for canonical URL */
    const pageId  = evt.entity.id;
    const pageObj = await notion.pages.retrieve({ page_id: pageId });
    const pageURL = pageObj.url;
    console.log('[Step 1] page.id', pageId);
    console.log('[Step 1] page.url', pageURL);

    if (!pageURL) throw new Error('no page.url');

    /* 2️⃣  find Monday row by exact URL */
    const itemId = await findMondayItem(pageURL);
    if (!itemId) {
      console.log('[Step 2] no Monday item – abort');
      return res.status(200).end('no monday row');
    }
    console.log('[Step 2] Monday item →', itemId);

    /* 3️⃣  crawl blocks (depth 0-2, paginated) */
    const mediaBlocks = [];
    await crawlBlocks(pageId, 0, mediaBlocks);
    console.log(`[Step 3] total media discovered (all levels) → ${mediaBlocks.length}`);

    const fresh = mediaBlocks.filter(b => !SEEN.has(b.id));
    fresh.forEach(b => SEEN.add(b.id));
    console.log(`[Step 3] new (never sent) media → ${fresh.length}`);

    if (!fresh.length) return res.status(200).end('nothing new');

    /* 4️⃣  upload */
    await Promise.all(
      fresh.map(b => queue.add(() => uploadToMonday(itemId, b)))
    );

    res.status(200).json({ ok:true, added: fresh.length });
  } catch (err) {
    console.error('[Fatal]', err);
    res.status(500).json({ ok:false, error: err.message });
  }
};

/* ────────────────────────────────────────── */
/* crawlBlocks – DFS with depth + pagination */
async function crawlBlocks(blockId, depth, out) {
  if (depth > 2) return;                 // hard stop

  let cursor;
  let page = 0;
  do {
    const { results, has_more, next_cursor } =
      await notion.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor,
        page_size: 100
      });

    console.log(`[crawl] depth=${depth} page=${++page} children=${results.length}`);

    for (const b of results) {
      if (['image','video','file','pdf','audio'].includes(b.type)) out.push(b);
      if (b.has_children) await crawlBlocks(b.id, depth + 1, out);
    }
    cursor = has_more ? next_cursor : undefined;
  } while (cursor);
}

/* ────────────────────────────────────────── */
/* findMondayItem – exact match on URL text  */
async function findMondayItem(url) {
  const query = `
    query ($v:[String]!) {
      items_page_by_column_values(
        board_id:${BOARD_ID},
        columns:[{column_id:"${URL_COL}", column_values:$v}],
        limit:1
      ){ items { id name } }
    }`;

  const resp = await fetch('https://api.monday.com/v2', {
    method :'POST',
    headers:{ 'Content-Type':'application/json', Authorization: MONDAY },
    body   : JSON.stringify({ query, variables:{ v:[url] } })
  }).then(r => r.json());

  if (resp.errors) {
    console.error('[findMondayItem] GraphQL error:', resp.errors);
    throw new Error(resp.errors[0].message);
  }

  const hit = resp.data.items_page_by_column_values.items[0];
  if (!hit) {
    console.log('[findMondayItem] no match for', url);
    return null;
  }
  console.log('[findMondayItem] match:', hit);
  return hit.id;
}

/* ────────────────────────────────────────── */
/* uploadToMonday – single file to column    */
async function uploadToMonday(itemId, block) {
  const data = block[block.type];
  const url  = data.file_upload?.id
      ? await notion.fileUploads.retrieve({ file_upload_id: data.file_upload.id }).then(r => r.url)
      : data.file?.url || data.external?.url;

  if (!url) {
    console.warn('[uploadToMonday] block w/o url', block.id);
    return;
  }

  const filename = path.basename(new URL(url).pathname) || `${block.id}.bin`;
  const buf      = Buffer.from(await (await fetch(url)).arrayBuffer());
  console.log(`[upload] ${filename} (${(buf.length/1e6).toFixed(2)} MB)`);

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

  if (resp.errors) {
    console.error('[uploadToMonday] Monday error:', resp.errors);
    throw new Error(resp.errors[0].message);
  }

  console.log(`[upload] ✔ ${filename} (asset ${resp.data.add_file_to_column.id})`);
}
