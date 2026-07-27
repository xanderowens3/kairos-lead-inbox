/* Probe the Trigify account: does the key work, what tier, what already exists. */
const KEY = process.env.TRIGIFY_API_KEY;
const BASE = 'https://api.trigify.io/v1';

async function call(path) {
  try {
    const r = await fetch(BASE + path, { headers: { 'x-api-key': KEY } });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: String(e.message || e) };
  }
}

const label = (s) => s === 200 ? 'OK' : s === 401 ? 'AUTH FAILED' : s === 403 ? 'FORBIDDEN (tier)'
  : s === 402 ? 'PAYMENT / TIER' : s === 404 ? 'NOT FOUND' : `HTTP ${s}`;

console.log('key loaded:', KEY ? `yes (${KEY.slice(0, 9)}…, ${KEY.length} chars)` : 'NO — .env not read');
console.log('');

const searches = await call('/searches');
console.log(`GET /searches          → ${label(searches.status)}`);
if (searches.status === 200) {
  const list = searches.body?.data ?? searches.body ?? [];
  const arr = Array.isArray(list) ? list : [];
  console.log(`   ${arr.length} search(es) on the account`);
  arr.forEach(s => console.log(`   · ${s.id}  "${s.name}"  [${s.status ?? '?'}]  ${(s.keywords ?? s.query ?? '')}`));
  if (!arr.length) console.log('   (raw)', JSON.stringify(searches.body).slice(0, 400));
} else {
  console.log('  ', JSON.stringify(searches.body).slice(0, 300));
}
console.log('');

for (const p of ['/topics', '/social/mapping?limit=1', '/profile/enrich?url=https://linkedin.com/in/test']) {
  const r = await call(p);
  console.log(`GET ${p.padEnd(22)}→ ${label(r.status)}`);
}
