/* Does keywords_and work without keywords? Capped at 5 results. */
const KEY = process.env.TRIGIFY_API_KEY;
const B = 'https://api.trigify.io/v1';
const H = { 'x-api-key': KEY, 'content-type': 'application/json' };
const g = async p => (await fetch(B + p, { headers: H })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const before = (await g('/usage')).data.credits;
console.log('credits consumed before :', before.total_consumed, JSON.stringify(before.by_feature));

const payload = {
  name: 'AND-only test',
  query: { monitoring_type: 'linkedin-posts', keywords_and: ['agency', 'clients'] },
  filters: { max_results: 10, time_frame: 'past-month', linkedin_sort_by: 'relevance', frequency: 'weekly' }
};
console.log('\ncreating:', JSON.stringify(payload.query));

const cr = await fetch(B + '/searches', { method: 'POST', headers: H, body: JSON.stringify(payload) });
const cj = await cr.json();
if (!cr.ok) { console.log('create failed', cr.status, JSON.stringify(cj).slice(0, 400)); process.exit(1); }
const id = cj.data.id;
console.log('created:', id, '| echoed query:', JSON.stringify(cj.data.query));

let d;
for (let i = 0; i < 20; i++) {
  await sleep(5000);
  d = (await g('/searches/' + id)).data;
  process.stdout.write(`  ${(i + 1) * 5}s status=${d.status} results=${d.total_results}\n`);
  if (d.status === 'completed' || d.total_results > 0) break;
}

const res = await g(`/searches/${id}/results?limit=10`);
const rows = res.data ?? [];
console.log(`\n${'='.repeat(70)}`);
console.log(`RESULT: status=${d.status}  total_results=${d.total_results}  rows returned=${rows.length}`);
console.log('='.repeat(70));

rows.forEach((r, i) => {
  const t = (r.content?.text || '').replace(/\s+/g, ' ');
  const hasAgency = /agency/i.test(t), hasClients = /clients/i.test(t);
  console.log(`\n${i + 1}. ${r.author?.name}`);
  console.log(`   contains "agency": ${hasAgency}   contains "clients": ${hasClients}`);
  console.log(`   ${t.slice(0, 160)}`);
});

const after = (await g('/usage')).data.credits;
console.log(`\ncredits consumed after  : ${after.total_consumed} ${JSON.stringify(after.by_feature)}`);
console.log(`COST OF THIS TEST       : ${after.total_consumed - before.total_consumed} credits`);
console.log(`\nsearch id (delete when done): ${id}`);
