/* ==========================================================================
   Scheduled ICPs — a client layer over the server's /data/schedules store.
   A scheduled ICP is one that hasn't been created in Trigify yet: it holds the
   Trigify create-payload and a daily run time. The server's scheduler creates
   it and runs analysis when the time arrives. Full-array PUT, like leads/offers.
   ========================================================================== */
let cache = [];

export async function loadSchedules(){
  const r = await fetch('/data/schedules');
  cache = r.ok ? await r.json() : [];
  if (!Array.isArray(cache)) cache = [];
  return cache;
}
export function allSchedules(){ return cache; }
export function schedulesForOffer(offerId){ return cache.filter(s => s.offerId === offerId); }

async function persist(){
  const r = await fetch('/data/schedules', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cache)
  });
  return r.ok;
}

export async function addSchedule(rec){
  cache.push(rec);
  return persist();
}

export async function cancelSchedule(id){
  const i = cache.findIndex(s => s.id === id);
  if (i < 0) return false;
  cache.splice(i, 1);
  return persist();
}

/* Next occurrence of a local HH:MM time, as an ISO instant (today if it's still
   ahead, otherwise tomorrow). Computed in the browser's timezone so the server
   fires at the user's chosen local time. */
export function nextOccurrence(hhmm){
  const [h, m] = hhmm.split(':').map(Number);
  const t = new Date();
  t.setHours(h, m, 0, 0);
  if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
  return t.toISOString();
}
