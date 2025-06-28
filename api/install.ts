import { VercelRequest, VercelResponse } from '@vercel/node';
import { Client as Notion } from '@notionhq/client';
import fetch from 'node-fetch';
import PQueue from 'p-queue';

const notion  = new Notion({ auth: process.env.NOTION_TOKEN });
const DB_ID   = process.env.NOTION_DB!;
const BOT_ID  = process.env.BOT_ID!;
const MONDAY  = process.env.MONDAY_TOKEN!;

// 3 parallel downloads/uploads at once
const queue = new PQueue({ concurrency: 3 });

/* ─────────────────────────  HELPERS  ───────────────────────── */

async function getMondayItem(itemId: number) {
  console.log(`[Monday] fetching item ${itemId}`);
  const query = `query ($id:[Int]) {
    items(ids:$id) {
      name
      column_values { id text }
      assets { id public_url name mimetype file_size }
    }
  }`;
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: MONDAY },
    body: JSON.stringify({ query, variables: { id: itemId } })
  }).then(r => r.json());

  if (r.errors) throw new Error(`[Monday] GraphQL error: ${JSON.stringify(r.errors)}`);
  console.log(`[Monday] item fetched, ${r.data.items[0].assets.length} asset(s)`);
  return r.data.items[0];
}

async function uploadToNotion(buf: Buffer, name: string, mime: string) {
  console.log(`[Notion] create file_upload for ${name} (${(buf.length/1e6).toFixed(2)} MB)`);
  const create = await fetch('https://api.notion.com/v1/file_uploads', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ mode: 'single_part', filename: name, content_type: mime })
  }).then(r => r.json());

  console.log(`[Notion] upload_url received, sending binary …`);
  await fetch(create.upload_url, { method: 'POST', headers: { 'Content-Type': mime }, body: buf });
  console.log(`[Notion] upload complete, file_upload_id = ${create.id}`);

  return create.id; // file_upload_id
}

/* ─────────────────────────  MAIN  ───────────────────────── */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('=== Incoming request ===');
  if (req.method !== 'POST') {
    console.error('Wrong method');
    return res.status(405).end('POST only');
  }

  const rawId = req.body?.itemId;
  const itemId = Number(rawId);
  if (!itemId || Number.isNaN(itemId)) {
    console.error('itemId missing/invalid:', rawId);
    return res.status(400).json({ ok: false, msg: 'itemId missing or invalid' });
  }

  try {
    /* 1 ── pull Monday data */
    const item = await getMondayItem(itemId);
    const col = (id: string) => item.column_values.find((c: any) => c.id === id)?.text || '';

    /* 2 ── process every asset, unlimited count */
    const files: any[] = [];

    console.log(`[Assets] preparing ${item.assets.length} file(s) …`);
    await Promise.all(
      item.assets.map(a =>
        queue.add(async () => {
          console.log(`[DL] ${a.name} (${(a.file_size/1e6).toFixed(2)} MB) → downloading …`);
          const resp = await fetch(a.public_url);
          const buf  = await resp.buffer();
          console.log(`[DL] ${a.name} done, ${(buf.length/1e6).toFixed(2)} MB`);

          if (buf.length <= 20 * 1024 * 1024) {
            const fid = await uploadToNotion(buf, a.name, a.mimetype);
            files.push({ name: a.name, type: 'file_upload', file_upload: { id: fid } });
          } else {
            console.log(`[SkipUpload] ${a.name} >20 MB, keeping external`);
            files.push({ name: a.name, type: 'external', external: { url: a.public_url } });
          }
        })
      )
    );
    console.log(`[Assets] all assets processed, total attached = ${files.length}`);

    /* 3 ── create the Notion page */
    console.log('[Notion] creating page …');
    const page = await notion.pages.create({
      parent: { database_id: DB_ID },
      properties: {
        Title:   { title: [{ text: { content: item.name } }] },
        Adresas: { rich_text: [{ text: { content: col('address') } }] },
        Dates:   { date: { start: col('date') } },
        Status:  { status: { name: 'backlog' } },
        People:  { people: [{ object: 'user', id: BOT_ID }] },
        files:   { files }
      },
      children: files.map(f => ({
        object: 'block',
        type: f.name.match(/\.mp4$/i) ? 'video' : 'image',
        ...(f.name.match(/\.mp4$/i) ? { video: f } : { image: f })
      }))
    });
    console.log(`[Notion] page created → ${page.url}`);

    return res.status(200).json({ ok: true, url: page.url, attachments: files.length });
  } catch (err: any) {
    console.error('[ERROR]', err.message, err.stack);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
