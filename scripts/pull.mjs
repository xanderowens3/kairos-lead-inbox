/* Pull raw results from the existing searches so we can see what we're working with. */
import { writeFileSync, mkdirSync } from 'node:fs';

const KEY = process.env.TRIGIFY_API_KEY;
const BASE = 'https://api.trigify.io/v1';

const SEARCHES = [
  { id: '97ed1afc-eff3-4540-8451-0b2586b88a5a', name: 'Competitor mentions' },
  { id: 'c8a71221-9ef2-4fd9-ba2c-409cb01b5726', name: 'AI Systems Technologies mentions' }
];

async function get(path) {
  const r = await fetch(BASE + path, { headers: { 'x-api-key': KEY } });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; }
  catch { return { status: r.status, body: t.slice(0, 500) }; }
}

mkdirSync('out', { recursive: true });
const all = {};

for (const s of SEARCHES) {
  console.log(`\n=== ${s.name} (${s.id}) ===`);

  const meta = await get(`/searches/${s.id}`);
  console.log('meta:', JSON.stringify(meta.body).slice(0, 500));

  const res = await get(`/searches/${s.id}/results?limit=100`);
  console.log('results status:', res.status);

  if (res.status !== 200) {
    console.log('body:', JSON.stringify(res.body).slice(0, 400));
    continue;
  }

  const b = res.body;
  const rows = Array.isArray(b) ? b : (b.data ?? b.results ?? b.mentions ?? []);
  console.log('rows:', rows.length, '| top-level keys:', Object.keys(b).join(', '));

  if (rows.length) {
    console.log('\n--- shape of one row ---');
    console.log(JSON.stringify(rows[0], null, 2).slice(0, 1400));
    const platforms = {};
    rows.forEach(r => { const p = r.platform ?? r.source ?? '?'; platforms[p] = (platforms[p] || 0) + 1; });
    console.log('\nplatforms:', JSON.stringify(platforms));
  }

  all[s.name] = { meta: meta.body, count: rows.length, rows };
}

writeFileSync('out/raw.json', JSON.stringify(all, null, 2));
console.log('\nwrote out/raw.json');
