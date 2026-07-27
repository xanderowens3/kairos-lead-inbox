/* ==========================================================================
   Leads — client data layer over the server's /data/leads store.
   Inbox = recommended leads from the last 3 days. Leads = all recommended,
   all-time. Ranked by score. Feedback (rating) is saved back per lead.
   ========================================================================== */

import { thresholdFor } from './offers.js';

let cache = [];

/* A lead lands in the inbox if the user promoted it, or its score clears the
   ICP's threshold. Derived live so changing a threshold re-filters instantly. */
export function isRecommended(l){
  return !!l.promoted || l.score >= thresholdFor(l.icpId);
}
export function leadsForIcp(icpId){
  return cache.filter(l => l.icpId === icpId)
    .sort((a, b) => (b.score - a.score) || (new Date(b.analyzedAt) - new Date(a.analyzedAt)));
}

// Serialize writes, and make every read wait for pending writes to land first.
// Without this, a background refetch triggered right after a delete can read the
// server BEFORE the delete's PUT commits and resurrect the lead.
let writeChain = Promise.resolve();

export async function loadLeads(){
  await writeChain;                        // never read ahead of an in-flight write
  const r = await fetch('/data/leads');
  let data = r.ok ? await r.json() : [];
  if (!Array.isArray(data)) data = [];
  cache = data;
  return cache;
}
export function loaded(){ return cache.length > 0; }
export function allLeads(){ return cache; }
export function leadById(id){ return cache.find(l => l.id === id); }

function persist(){
  // queue behind any prior write; each write PUTs the whole (current) cache
  writeChain = writeChain.then(() =>
    fetch('/data/leads', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cache)
    }).then(r => r.ok).catch(() => false)
  );
  return writeChain;
}

/* Recommended leads, most recent first (tiebroken by score). */
export function recommended(){
  return cache.filter(isRecommended)
    .sort((a, b) => (new Date(b.analyzedAt) - new Date(a.analyzedAt)) || (b.score - a.score));
}

const DAYS3 = 3 * 24 * 3600 * 1000;
export function inbox(){
  const cutoff = Date.now() - DAYS3;
  return recommended().filter(l => !l.contacted && new Date(l.analyzedAt).getTime() >= cutoff);
}

export function countInbox(){ return inbox().length; }

/* Mark a lead contacted — drops it from the inbox, keeps it under All leads. */
export async function markContacted(id){
  const l = leadById(id);
  if (!l) return false;
  l.contacted = true;
  l.contactedAt = new Date().toISOString();
  return persist();
}

/* Promote a below-threshold lead into the inbox (or undo it). */
export async function promoteLead(id, on = true){
  const l = leadById(id);
  if (!l) return false;
  l.promoted = !!on;
  return persist();
}

/* Pin a lead as a permanent feedback example that never ages out. */
export async function pinGolden(id, on = true){
  const l = leadById(id);
  if (!l) return false;
  l.golden = !!on;
  return persist();
}

/* Delete a lead permanently from the store. Splices the cache synchronously so
   the UI can update instantly; the server write and unguard happen after. */
export async function deleteLead(id){
  const i = cache.findIndex(l => l.id === id);
  if (i >= 0) cache.splice(i, 1);
  return persist();
}

/* Rate a lead — feeds future analysis runs as a few-shot example.
   userScore is the number the user thinks it should have scored (calibration). */
export async function rateLead(id, rating, note, userScore){
  const l = leadById(id);
  if (!l) return false;
  l.rating = rating || null;      // 'good' | 'bad' | null
  l.ratingNote = note || null;
  if (userScore != null){
    if (l.agentScore == null) l.agentScore = l.score;   // keep the agent's original for reference
    l.score = userScore;                                // the lead now shows the user's score
    l.userScore = userScore;
  }
  l.ratedAt = new Date().toISOString();
  return persist();
}

/* POST an analysis run for an offer. maxPosts caps the batch for cheap tests. */
export async function analyzeOffer(offerId, maxPosts){
  const q = maxPosts ? `?max=${maxPosts}` : '';
  const r = await fetch(`/analyze/${offerId}${q}`, { method: 'POST' });
  const body = await r.json().catch(() => ({ error: 'bad response' }));
  await loadLeads();
  return body;
}
