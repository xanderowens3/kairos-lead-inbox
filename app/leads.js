/* ==========================================================================
   Leads — client data layer over the server's /data/leads store.
   Inbox = recommended leads from the last 3 days. Leads = all recommended,
   all-time. Ranked by score. Feedback (rating) is saved back per lead.
   ========================================================================== */

let cache = [];

export async function loadLeads(){
  const r = await fetch('/data/leads');
  cache = r.ok ? await r.json() : [];
  if (!Array.isArray(cache)) cache = [];
  return cache;
}
export function allLeads(){ return cache; }
export function leadById(id){ return cache.find(l => l.id === id); }

async function persist(){
  const r = await fetch('/data/leads', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cache)
  });
  return r.ok;
}

/* Recommended leads, newest analysis first tiebroken by score. */
export function recommended(){
  return cache.filter(l => l.recommend)
    .sort((a, b) => (b.score - a.score) || (new Date(b.analyzedAt) - new Date(a.analyzedAt)));
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

/* Delete a lead permanently from the store. */
export async function deleteLead(id){
  const i = cache.findIndex(l => l.id === id);
  if (i < 0) return false;
  cache.splice(i, 1);
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
