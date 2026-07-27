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

// In-flight optimistic changes, so a background refetch can't resurrect a lead
// the user just deleted or un-inbox a lead they just marked contacted.
const pendingDeletes = new Set();
const pendingContacts = new Set();

export async function loadLeads(){
  const r = await fetch('/data/leads');
  let data = r.ok ? await r.json() : [];
  if (!Array.isArray(data)) data = [];
  if (pendingDeletes.size) data = data.filter(l => !pendingDeletes.has(l.id));
  if (pendingContacts.size) for (const l of data) if (pendingContacts.has(l.id)) l.contacted = true;
  cache = data;
  return cache;
}
export function loaded(){ return cache.length > 0; }
export function allLeads(){ return cache; }
export function leadById(id){ return cache.find(l => l.id === id); }

async function persist(){
  const r = await fetch('/data/leads', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cache)
  });
  return r.ok;
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
  pendingContacts.add(id);
  const ok = await persist();
  pendingContacts.delete(id);
  return ok;
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
  pendingDeletes.add(id);
  const ok = await persist();
  pendingDeletes.delete(id);
  return ok;
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
