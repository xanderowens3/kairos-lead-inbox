/* Does a multi-word keywords_and term ("looking for") act as a literal phrase,
   or does Trigify tokenize it and only enforce individual words (or ignore it)?  */
const KEY = process.env.TRIGIFY_API_KEY;
const B = 'https://api.trigify.io/v1';
const H = { 'x-api-key': KEY, 'content-type': 'application/json' };
const g = async p => (await fetch(B + p, { headers: H })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const payload = {
  name: 'phrase-and-test',
  query: { monitoring_type: 'linkedin-posts', keywords_and: ['looking for'] },
  filters: { max_results: 10, time_frame: 'past-week', linkedin_sort_by: 'relevance', frequency: 'weekly' }
};
console.log('query:', JSON.stringify(payload.query));

const cr = await fetch(B + '/searches', { method:'POST', headers:H, body: JSON.stringify(payload) });
const cj = await cr.json();
if (!cr.ok) { console.log('create failed', cr.status, JSON.stringify(cj)); process.exit(1); }
const id = cj.data.id;
console.log('created:', id, '| echoed query:', JSON.stringify(cj.data.query));

let d;
for (let i = 0; i < 20; i++) {
  await sleep(5000);
  d = (await g('/searches/' + id)).data;
  console.log(`  ${(i+1)*5}s status=${d.status} results=${d.total_results}`);
  if (d.status === 'completed') break;
}

const rows = (await g(`/searches/${id}/results?limit=10`)).data ?? [];
console.log('\n' + '='.repeat(70));
console.log(`rows=${rows.length}`);
console.log('='.repeat(70));

let phraseHits = 0, wordOnlyHits = 0;
rows.forEach((r,i) => {
  const t = (r.content?.text || '').toLowerCase();
  const phrase = /looking for/.test(t);
  const word = /\blooking\b/.test(t);
  if (phrase) phraseHits++; else if (word) wordOnlyHits++;
  console.log(`${i+1}. phrase="${phrase}" word-only="${!phrase && word}"  ${r.author?.name}`);
  console.log('   ' + t.replace(/\s+/g,' ').slice(0,140));
});

console.log(`\nliteral phrase "looking for": ${phraseHits}/${rows.length}`);
console.log('\nVERDICT:', phraseHits === rows.length
  ? 'Phrase enforced correctly — the earlier search had a different cause.'
  : phraseHits === 0
    ? 'CONFIRMED BUG: multi-word AND term is not enforced as a phrase at all.'
    : 'PARTIAL: phrase sometimes enforced, sometimes not — inconsistent.');
console.log('\nsearch id (delete when done):', id);
