/* Does `keywords` narrow or broaden when combined with `keywords_and`?
   AND = agency + clients (known to return 10)
   OR  = zeppelin (absurd — cannot co-occur with an agency post)

   narrows  → 0 results   (match = all AND *and* at least one OR)
   broadens → ~10 results (match = all AND *or* any OR)                        */
const KEY = process.env.TRIGIFY_API_KEY;
const B = 'https://api.trigify.io/v1';
const H = { 'x-api-key': KEY, 'content-type': 'application/json' };
const g = async p => (await fetch(B + p, { headers: H })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const before = (await g('/usage')).data;
console.log('before — consumed:', before.credits.total_consumed,
            '| collected:', before.results.total_collected);

const payload = {
  name: 'OR semantics test',
  query: { monitoring_type: 'linkedin-posts',
           keywords_and: ['agency', 'clients'],
           keywords: ['zeppelin'] },
  filters: { max_results: 10, time_frame: 'past-month',
             linkedin_sort_by: 'relevance', frequency: 'weekly' }
};
console.log('\nquery:', JSON.stringify(payload.query));

const cr = await fetch(B + '/searches', { method:'POST', headers:H, body: JSON.stringify(payload) });
const cj = await cr.json();
if (!cr.ok) { console.log('create failed', cr.status, JSON.stringify(cj).slice(0,400)); process.exit(1); }
const id = cj.data.id;
console.log('created:', id);

let d;
for (let i = 0; i < 24; i++) {
  await sleep(5000);
  d = (await g('/searches/' + id)).data;
  console.log(`  ${(i+1)*5}s status=${d.status} results=${d.total_results}`);
  if (d.status === 'completed') break;
}

const rows = (await g(`/searches/${id}/results?limit=10`)).data ?? [];
console.log('\n' + '='.repeat(66));
console.log(`status=${d.status}  total_results=${d.total_results}  rows=${rows.length}`);
console.log('='.repeat(66));

if (rows.length) {
  console.log('\nchecking which terms each result actually contains:\n');
  rows.forEach((r,i) => {
    const t = (r.content?.text || '').toLowerCase();
    console.log(`${String(i+1).padStart(2)}. agency=${/agenc(y|ies)/.test(t)?'Y':'n'}`
      + ` clients=${/client(s)?/.test(t)?'Y':'n'}`
      + ` zeppelin=${/zeppelin/.test(t)?'Y':'n'}   ${r.author?.name}`);
  });
}

await sleep(4000);
const after = (await g('/usage')).data;
console.log(`\nafter  — consumed: ${after.credits.total_consumed} | collected: ${after.results.total_collected}`);
console.log(`cost of this test : ${after.credits.total_consumed - before.credits.total_consumed} credits`);

console.log('\nVERDICT:', d.total_results === 0
  ? 'OR NARROWS — at least one OR term is required alongside all AND terms.'
  : 'OR BROADENS — a post matches on AND terms alone, OR terms are additive.');
console.log('search id:', id);
