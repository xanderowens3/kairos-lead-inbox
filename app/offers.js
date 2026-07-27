/* ==========================================================================
   Offers — the context object the qualification agent reads.
   Persisted server-side to data/offers.json so scripts/qualify.mjs sees it too.
   ========================================================================== */

export const blankOffer = () => ({
  id: 'off_' + Math.random().toString(36).slice(2, 10),
  name: '',
  sell: '',
  icpText: '',
  pains: [''],
  qualifiers: [''],
  disqualifiers: [''],
  goodExample: '',
  badExample: '',
  searchIds: [],
  createdAt: new Date().toISOString()
});

let cache = [];

export async function loadOffers(){
  const r = await fetch('/data/offers');
  cache = r.ok ? await r.json() : [];
  if (!Array.isArray(cache)) cache = [];
  return cache;
}
export function offers(){ return cache; }
export function offerById(id){ return cache.find(o => o.id === id); }

export async function saveOffers(list){
  cache = list;
  const r = await fetch('/data/offers', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(list)
  });
  return r.ok;
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

export async function attachSearch(offerId, searchId){
  const o = offerById(offerId);
  if (!o) return false;
  o.searchIds = [...new Set([...(o.searchIds || []), searchId])];
  return saveOffers([...cache]);
}

export async function detachSearch(offerId, searchId){
  const o = offerById(offerId);
  if (!o) return false;
  o.searchIds = (o.searchIds || []).filter(x => x !== searchId);
  return saveOffers([...cache]);
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
  const checks = [
    ['What you sell',        !!o.sell?.trim()],
    ['Who it is for',        !!o.icpText?.trim()],
    ['Problems you remove',  (o.pains || []).filter(Boolean).length > 0],
    ['ICP qualifiers',       (o.qualifiers || []).filter(Boolean).length > 0],
    ['ICP disqualifiers',    (o.disqualifiers || []).filter(Boolean).length > 0],
    ['Example of a fit',     !!o.goodExample?.trim()],
    ['Example of a near-miss', !!o.badExample?.trim()]
  ];
  return { checks, done: checks.filter(c => c[1]).length, total: checks.length };
}
