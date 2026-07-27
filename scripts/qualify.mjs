/* ==========================================================================
   Qualify an offer's collected posts against that offer's context.

     node --env-file=.env scripts/qualify.mjs              list offers
     node --env-file=.env scripts/qualify.mjs <offer-id>   qualify it

   Reads data/offers.json — the same file the UI writes.
   ========================================================================== */
import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { verifyResults } from '../app/schema.js';

const MODEL = 'claude-haiku-4-5';
const BATCH = 8;
const TRIGIFY = 'https://api.trigify.io/v1';
const KEY = process.env.TRIGIFY_API_KEY;

const offers = JSON.parse(await readFile('data/offers.json', 'utf8').catch(() => '[]'));
if (!offers.length){ console.error('No offers yet — create one in the app first.'); process.exit(1); }

const arg = process.argv[2];
if (!arg){
  console.log('\nOffers:\n');
  offers.forEach(o => console.log(`  ${o.id}   ${o.name}   (${(o.searchIds||[]).length} ICPs)`));
  console.log('\nRun:  node --env-file=.env scripts/qualify.mjs <offer-id>\n');
  process.exit(0);
}
const offer = offers.find(o => o.id === arg || o.name === arg);
if (!offer){ console.error(`No offer "${arg}"`); process.exit(1); }
if (!(offer.searchIds || []).length){ console.error('That offer has no ICPs yet.'); process.exit(1); }

/* ---------- collect posts from every ICP on the offer ----------
   Qualify EVERY collected post, not just literal keyword matches. Strong
   pain-point posts rarely contain the exact keywords, so the loose matches
   are often the best leads — the model judges on meaning, which is the whole
   point. Keyword-match status is passed through only as a hint. */
const g = async p => (await fetch(TRIGIFY + p, { headers:{ 'x-api-key': KEY } })).json();
const posts = [];
for (const sid of offer.searchIds){
  const meta = (await g('/searches/' + sid)).data;
  const rows = (await g(`/searches/${sid}/results?limit=100`)).data ?? [];
  const { matched } = verifyResults(rows, meta?.query || {});
  const full = new Set(matched.map(r => r.id));
  console.log(`  ${meta?.name ?? sid}: ${rows.length} post(s)  (${matched.length} contain every keyword)`);
  rows.forEach(r => posts.push({ ...r, icp: meta?.name ?? sid, fullMatch: full.has(r.id) }));
}
if (!posts.length){ console.error('\nNothing collected yet on any ICP.'); process.exit(1); }

/* ---------- the context object the agent reads ---------- */
const list = a => (a||[]).filter(Boolean).map(x => '- ' + x).join('\n') || '- (none given)';

const SYSTEM = `You screen social media posts to find people who might buy a specific offer.

THE OFFER
${offer.sell || '(not described)'}

WHO IT IS FOR
${offer.icpText || '(not described)'}

PROBLEMS IT REMOVES
${list(offer.pains)}

NEVER SURFACE THESE
${list(offer.disqualifiers)}
${offer.goodExample ? `
AN EXAMPLE OF A REAL FIT
${offer.goodExample}
` : ''}${offer.badExample ? `
AN EXAMPLE THAT LOOKS CLOSE BUT IS NOT A FIT
${offer.badExample}
` : ''}
HOW TO JUDGE
A post is a lead only if the author personally appears to have the problem this offer
removes, AND plausibly fits the target description. Both must hold.

Be strict. A false positive costs more than a missed lead — the user reads every result
personally. Most posts are not leads. Reject self-promotion, certification and course
announcements, hiring posts written by job boards or recruiters, news commentary,
industry analysis, and vendors marketing their own services.

Note: an agency owner hiring their own salesperson is usually a strong signal, not noise.
A job board advertising a role is noise. Judge who is speaking, not the topic.

You only see the post text, the author's display name and their profile URL. You do NOT
see their job title, company or seniority. Do not invent them. Judge fit from what the
post reveals, and set icp_fit to "unknown" when it gives you nothing to go on. Strong pain
with unknown fit is worth surfacing at a lower score; no pain is never a lead.

score: 0-100. Above 70 means you would stake your reputation on it being worth reading.
evidence: the exact phrase showing the problem, or null.
reason: one or two plain sentences. Say why, not what.`;

const schema = {
  type:'object', additionalProperties:false, required:['verdicts'],
  properties:{ verdicts:{ type:'array', items:{
    type:'object', additionalProperties:false,
    required:['id','verdict','score','icp_fit','evidence','reason'],
    properties:{
      id:{type:'string'}, verdict:{type:'string',enum:['lead','reject']},
      score:{type:'integer'}, icp_fit:{type:'string',enum:['clear','likely','unknown','no']},
      evidence:{type:['string','null']}, reason:{type:'string'} } } } }
};

const client = new Anthropic();
const clean = t => (t||'').replace(/\s+/g,' ').trim().slice(0,900);

async function judge(batch){
  const payload = batch.map(r =>
    `<post id="${r.id}">\nauthor: ${r.author?.name ?? 'unknown'}\nprofile: ${r.author?.profile_url ?? ''}\ntext: ${clean(r.content?.text)}\n</post>`
  ).join('\n\n');
  const res = await client.messages.create({
    model: MODEL, max_tokens: 4000, system: SYSTEM,
    output_config: { format: { type:'json_schema', schema } },
    messages: [{ role:'user', content:`Judge each post. One verdict per post id.\n\n${payload}` }]
  });
  const text = res.content.find(b => b.type === 'text')?.text ?? '{"verdicts":[]}';
  return { verdicts: JSON.parse(text).verdicts ?? [], usage: res.usage };
}

/* ---------- run ---------- */
console.log(`\nOffer:  ${offer.name}`);
console.log(`Posts:  ${posts.length}   Model: ${MODEL}\n`);

const all = []; let inTok = 0, outTok = 0;
for (let i = 0; i < posts.length; i += BATCH){
  const batch = posts.slice(i, i + BATCH);
  process.stdout.write(`  batch ${Math.floor(i/BATCH)+1}/${Math.ceil(posts.length/BATCH)} … `);
  try {
    const { verdicts, usage } = await judge(batch);
    inTok += usage.input_tokens; outTok += usage.output_tokens;
    all.push(...verdicts);
    console.log(`${verdicts.filter(v => v.verdict === 'lead').length} lead(s)`);
  } catch (e){ console.log('FAILED —', e.message); }
}

const byId = Object.fromEntries(posts.map(p => [p.id, p]));
const rich = all.map(v => ({ ...v,
  name: byId[v.id]?.author?.name,
  profile: byId[v.id]?.author?.profile_url,
  postUrl: byId[v.id]?.content?.url,
  icp: byId[v.id]?.icp,
  text: clean(byId[v.id]?.content?.text) }));

const leads = rich.filter(v => v.verdict === 'lead').sort((a,b) => b.score - a.score);
const rejects = rich.filter(v => v.verdict === 'reject').sort((a,b) => b.score - a.score);

await mkdir('out', { recursive: true });
await writeFile(`out/leads-${offer.id}.json`,
  JSON.stringify({ offer: offer.name, generated: new Date().toISOString(), leads, rejects }, null, 2));

const cost = (inTok/1e6)*1 + (outTok/1e6)*5;
console.log(`\n${'='.repeat(72)}`);
console.log(`${leads.length} lead(s) from ${posts.length} posts  ·  ~$${cost.toFixed(3)}`);
console.log('='.repeat(72));

if (leads.length){
  console.log('\nLEADS\n');
  leads.forEach(l => {
    console.log(`  ${l.score}  ${l.name}   [${l.icp}]  fit: ${l.icp_fit}`);
    console.log(`      ${l.reason}`);
    if (l.evidence) console.log(`      "${l.evidence}"`);
    console.log(`      ${l.postUrl}\n`);
  });
} else {
  console.log('\nNo leads. Closest rejections:\n');
  rejects.slice(0,5).forEach(r =>
    console.log(`  ${String(r.score).padStart(2)}  ${(r.name||'?').padEnd(24).slice(0,24)} ${r.reason}`));
}
console.log(`\nFull output → out/leads-${offer.id}.json`);
