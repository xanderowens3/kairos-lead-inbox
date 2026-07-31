/* ==========================================================================
   Offers — the context object the qualification agent reads.
   Persisted server-side to data/offers.json so scripts/qualify.mjs sees it too.
   ========================================================================== */

/* The score bands a worked example can be pinned to. 10–50 are the posts you
   would not contact, 60–100 the ones you would. */
export const NEG_BANDS = [10, 20, 30, 40, 50];
export const POS_BANDS = [60, 70, 80, 90, 100];
export const SCORE_BANDS = [...NEG_BANDS, ...POS_BANDS];

export const blankExamples = () =>
  Object.fromEntries(SCORE_BANDS.map(b => [b, { post: '', why: '' }]));

export const blankOffer = () => ({
  id: 'off_' + Math.random().toString(36).slice(2, 10),
  name: '',
  sell: '',
  icpText: '',
  pains: [''],
  qualifiers: [{ text: '', weight: 5 }],
  disqualifiers: [{ text: '', weight: 5 }],
  scoreExamples: blankExamples(),
  searchIds: [],
  createdAt: new Date().toISOString()
});

export const clampWeight = n => Math.max(1, Math.min(10, Math.round(Number(n) || 5)));

/* Bring any offer up to the current shape. Qualifiers used to be plain strings
   and there were two loose example fields; both are carried over rather than
   dropped, so nothing a user wrote is lost. Safe to run repeatedly. */
export function normalizeOffer(o){
  if (!o || typeof o !== 'object') return o;
  const weighted = arr => (arr || [])
    .map(v => typeof v === 'string' ? { text: v, weight: 5 }
                                    : { text: v?.text ?? '', weight: clampWeight(v?.weight) });
  o.qualifiers    = weighted(o.qualifiers);
  o.disqualifiers = weighted(o.disqualifiers);
  o.pains = (o.pains || []).map(p => typeof p === 'string' ? p : (p?.text ?? ''));

  const ex = o.scoreExamples || {};
  o.scoreExamples = Object.fromEntries(SCORE_BANDS.map(b => [b, {
    post: ex[b]?.post ?? '', why: ex[b]?.why ?? ''
  }]));
  if (o.goodExample && !o.scoreExamples[80].post) o.scoreExamples[80].post = o.goodExample;
  if (o.badExample  && !o.scoreExamples[30].post) o.scoreExamples[30].post = o.badExample;
  delete o.goodExample; delete o.badExample;
  return o;
}

export const filledExamples = o =>
  SCORE_BANDS.filter(b => (o.scoreExamples?.[b]?.post || '').trim()).length;

let cache = [];

// serialize writes; reads wait for them (see leads.js for the rationale)
let writeChain = Promise.resolve();

export async function loadOffers(){
  await writeChain;
  const r = await fetch('/data/offers');
  cache = r.ok ? await r.json() : [];
  if (!Array.isArray(cache)) cache = [];
  cache.forEach(normalizeOffer);          // old offers get the current shape on read
  return cache;
}
export function offers(){ return cache; }
export function offerById(id){ return cache.find(o => o.id === id); }

export function saveOffers(list){
  cache = list;
  writeChain = writeChain.then(() =>
    fetch('/data/offers', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(list)
    }).then(r => r.ok).catch(() => false));
  return writeChain;
}

export async function upsertOffer(offer){
  const list = [...cache];
  const i = list.findIndex(o => o.id === offer.id);
  i >= 0 ? list[i] = offer : list.push(offer);
  return saveOffers(list);
}

export async function removeOffer(id){
  return saveOffers(cache.filter(o => o.id !== id));
}

/* ICP membership is server-owned — a whole-array save carries whatever the
   browser cached, which could wipe live links or resurrect deleted ones. Both
   attach and detach therefore go through their own endpoints. */
export async function attachSearch(offerId, searchId, minScore){
  const o = offerById(offerId);
  if (o) o.searchIds = [...new Set([...(o.searchIds || []), searchId])];
  const r = await fetch(`/data/offers/${encodeURIComponent(offerId)}/icps`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ searchId, minScore })
  });
  return r.ok;
}

/* Detaching is the one operation a whole-array save cannot express, because the
   server never lets a PUT shrink searchIds (a stale copy used to wipe them all).
   So removal goes through its own endpoint. */
export async function detachSearch(offerId, searchId){
  const o = offerById(offerId);
  if (!o) return false;
  o.searchIds = (o.searchIds || []).filter(x => x !== searchId);
  const r = await fetch(`/data/offers/${encodeURIComponent(offerId)}/icps/${encodeURIComponent(searchId)}`,
    { method: 'DELETE' });
  return r.ok;
}

/* ---- per-ICP inbox threshold (score at/above which a lead is recommended) ---- */
export const DEFAULT_MIN_SCORE = 50;

export function offerForSearch(searchId){
  return cache.find(o => (o.searchIds || []).includes(searchId));
}
export function thresholdFor(searchId){
  const o = offerForSearch(searchId);
  return o?.icpThresholds?.[searchId] ?? DEFAULT_MIN_SCORE;
}
export async function setThreshold(searchId, n){
  const o = offerForSearch(searchId);
  if (!o) return false;
  o.icpThresholds = { ...(o.icpThresholds || {}), [searchId]: Math.max(0, Math.min(100, n)) };
  return saveOffers([...cache]);
}

/* how complete is the context the agent will read? */
export function readiness(o){
  const has = arr => (arr || []).filter(x => (typeof x === 'string' ? x : x?.text)?.trim()).length > 0;
  const n = filledExamples(o);
  const checks = [
    ['What you sell',                 !!o.sell?.trim()],
    ['Who it is for',                 !!o.icpText?.trim()],
    ['Problems you solve',            has(o.pains)],
    ['ICP qualifiers',                has(o.qualifiers)],
    ['ICP disqualifiers',             has(o.disqualifiers)],
    ['Scored examples (2+)',          n >= 2],
    ['A full scale (6+ examples)',    n >= 6]
  ];
  return { checks, done: checks.filter(c => c[1]).length, total: checks.length };
}
