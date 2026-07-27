/* ==========================================================================
   Local server
     /api/*          → proxied to Trigify with the API key
     /data/offers    → offer store (GET / PUT), data/offers.json
     /data/leads     → leads store (GET / PUT), data/leads.json
     /analyze/:id    → POST: pull an offer's ICP results, score new posts with
                       Claude, append recommended leads. Uses ANTHROPIC_API_KEY
                       server-side so the key never reaches the browser.
   Run:  node --env-file=.env server.mjs
   ========================================================================== */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { judgeBatch, BATCH, MODEL } from './app/qualify-core.mjs';
import { verifyResults } from './app/schema.js';
import { initDb, usingDb, getOffers, saveOffers, getLeads, saveLeads,
         getProfiles, saveProfiles, getSchedules, saveSchedules } from './db.mjs';

/* $ per million tokens [input, output]. Sonnet 5 intro pricing runs to 2026-08-31. */
const RATES = {
  'claude-sonnet-5':  [2, 10],
  'claude-haiku-4-5': [1, 5],
  'claude-opus-5':    [5, 25]
};
const priceOf = (inTok, outTok) => {
  const [i, o] = RATES[MODEL] || [2, 10];
  return (inTok/1e6)*i + (outTok/1e6)*o;
};

const PORT = Number(process.env.PORT) || 4173;
// Railway (and most hosts) inject PORT and require binding to all interfaces.
// Locally, with no PORT set, keep it bound to localhost only.
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'app');
const OFFERS = join(HERE, 'data', 'offers.json');
const LEADS  = join(HERE, 'data', 'leads.json');
const PROFILES = join(HERE, 'data', 'profiles.json');   // enriched-profile cache, keyed by URL
const KEY = process.env.TRIGIFY_API_KEY;
const TRIGIFY = 'https://api.trigify.io/v1';

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
               '.json':'application/json', '.svg':'image/svg+xml', '.mjs':'text/javascript' };

if (!KEY) { console.error('TRIGIFY_API_KEY missing — set it as an env var (locally: node --env-file=.env server.mjs)'); process.exit(1); }
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const send = (res, code, body, type='application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const readBody = async req => {
  let b = ''; for await (const c of req) b += c;
  try { return JSON.parse(b || '{}'); } catch { return null; }
};
const loadJSON = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
};
const saveJSON = async (path, data) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
};
const tg = async path => {
  const r = await fetch(TRIGIFY + path, { headers: { 'x-api-key': KEY } });
  return r.json();
};

/* ---------- profile enrichment (Trigify /profile/enrich) ----------
   Resolves a LinkedIn /in/ URL to job title, company, industry, follower count,
   location and summary — the fields the qualifiers/disqualifiers actually need.
   Cached to disk by URL (incl. failures, as null) so re-runs don't re-fetch. */
let profileCache = null;
const getProfileCache = async () => (profileCache ??= await getProfiles());

async function enrichProfile(url){
  if (!url || !/linkedin\.com\/in\//i.test(url)) return null;   // people only, not company pages
  const cache = await getProfileCache();
  if (Object.prototype.hasOwnProperty.call(cache, url)) return cache[url];
  try {
    const r = await fetch(TRIGIFY + '/profile/enrich', {
      method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ profileUrl: url })
    });
    if (!r.ok){ cache[url] = null; return null; }
    const p = (await r.json())?.data?.prospect || {};
    const prof = {
      name: p.full_name || null, jobTitle: p.job_title || null,
      company: p.job_company_name || null, industry: p.industry || null,
      followers: p.follower_count ?? null,
      location: p.location_country || p.location_name || null,
      summary: p.summary || null, urn: p.linkedin_urn || null
    };
    cache[url] = prof;
    return prof;
  } catch { return null; }
}

/* ---------- analysis: score an offer's new posts ---------- */
async function analyzeOffer(offerId, maxPosts){
  if (!anthropic) return { error: 'ANTHROPIC_API_KEY not set on the server' };
  const offers = await getOffers();
  const offer = offers.find(o => o.id === offerId);
  if (!offer) return { error: 'offer not found' };
  if (!(offer.searchIds || []).length) return { error: 'offer has no ICPs' };

  const leadsStore = await getLeads();
  const already = new Set(leadsStore.map(l => l.postId));

  /* gather new posts across the offer's ICPs, honouring the local keyword re-check */
  const fresh = [];
  for (const sid of offer.searchIds){
    const meta = (await tg('/searches/' + sid)).data;
    const rows = (await tg(`/searches/${sid}/results?limit=100`)).data ?? [];
    const { matched } = verifyResults(rows, meta?.query || {});
    for (const r of matched){
      if (!already.has(r.id)) fresh.push({ ...r, icpId: sid, icpName: meta?.name ?? sid });
    }
  }
  const toScore = fresh.slice(0, maxPosts || fresh.length);
  if (!toScore.length) return { analyzed: 0, recommended: 0, message: 'No new posts to analyze.' };

  /* feedback the user has given on this offer's past leads */
  const feedback = leadsStore
    .filter(l => l.offerId === offerId && (l.rating || l.userScore != null))
    .slice(-8)
    .map(l => ({ rating: l.rating, note: l.ratingNote, userScore: l.userScore, text: l.text }));

  let inTok = 0, outTok = 0, cacheRead = 0, recommended = 0, enriched = 0;
  const now = new Date().toISOString();
  const creditsBefore = (await tg('/usage'))?.data?.credits?.total_consumed ?? 0;

  for (let i = 0; i < toScore.length; i += BATCH){
    const batch = toScore.slice(i, i + BATCH);
    // enrich this batch's authors in parallel, attach to each post for scoring
    await Promise.all(batch.map(async p => {
      p.profile = await enrichProfile(p.author?.profile_url);
      if (p.profile) enriched++;
    }));

    const { verdicts, usage } = await judgeBatch(anthropic, offer, batch, feedback);
    inTok += usage.input_tokens; outTok += usage.output_tokens;
    cacheRead += usage.cache_read_input_tokens || 0;
    const byId = Object.fromEntries(batch.map(p => [p.id, p]));
    for (const v of verdicts){
      const p = byId[v.id]; if (!p) continue;
      const pr = p.profile || {};
      leadsStore.push({
        id: 'lead_' + v.id,
        postId: v.id,
        offerId, offerName: offer.name,
        icpId: p.icpId, icpName: p.icpName,
        recommend: !!v.recommend,
        score: v.score, icpFit: v.icp_fit,
        reason: v.reason, evidence: v.evidence,
        author: p.author?.name, profileUrl: p.author?.profile_url,
        jobTitle: pr.jobTitle ?? null, company: pr.company ?? null,
        industry: pr.industry ?? null, followers: pr.followers ?? null,
        location: pr.location ?? null, summary: pr.summary ?? null,
        postUrl: p.content?.url, text: p.content?.text,
        publishedAt: p.published_at,
        analyzedAt: now, model: MODEL,
        rating: null, ratingNote: null, userScore: null
      });
      if (v.recommend) recommended++;
    }
  }
  await saveLeads(leadsStore);
  if (profileCache) await saveProfiles(profileCache);
  const creditsAfter = (await tg('/usage'))?.data?.credits?.total_consumed ?? creditsBefore;
  const enrichCredits = creditsAfter - creditsBefore;
  const cost = priceOf(inTok, outTok);
  console.log(`  analyzed ${toScore.length} → ${recommended} recommended · ${enriched} enriched`
    + ` · ~$${cost.toFixed(3)} Claude · ${enrichCredits} Trigify credits (${cacheRead} cached tokens)`);
  return { analyzed: toScore.length, recommended, enriched, remaining: fresh.length - toScore.length,
           cost: +cost.toFixed(4), enrichCredits, cacheRead };
}

/* ---------- scheduler: deferred ICP creation + daily analysis ----------
   A scheduled ICP holds a Trigify create-payload but isn't created yet. When
   its nextRun arrives, we create the search in Trigify (first run → collection
   begins), attach it to the offer, then run analysis so leads land in the inbox.
   Each run advances nextRun by 24h, so leads refresh every morning at the set
   time. Runs entirely in this always-on server — no external cron. */
const HOUR_MS = 3600 * 1000;
const FREQ_MS = { 'hourly': HOUR_MS, 'every-12h': 12*HOUR_MS, 'daily': 24*HOUR_MS,
  'weekly': 7*24*HOUR_MS, 'monthly': 30*24*HOUR_MS, 'quarterly': 90*24*HOUR_MS };
const intervalMs = sch => FREQ_MS[sch.frequency || sch.payload?.filters?.frequency] || FREQ_MS.daily;

async function createSearch(payload){
  const r = await fetch(TRIGIFY + '/searches', {
    method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || `Trigify ${r.status}`);
  return body?.data?.id;
}

async function runDueSchedule(sch){
  // first run: create the Trigify search and attach it to the offer
  if (!sch.searchId){
    const id = await createSearch(sch.payload);
    sch.searchId = id;
    sch.status = 'active';
    const offers = await getOffers();
    const off = offers.find(o => o.id === sch.offerId);
    if (off){
      off.searchIds = [...new Set([...(off.searchIds || []), id])];
      await saveOffers(offers);
    }
    console.log(`  scheduler: created ICP "${sch.name}" → ${id}`);
  }
  // deliver leads (Trigify backfills recent posts on creation, so day one can yield leads)
  if (anthropic){
    try {
      const r = await analyzeOffer(sch.offerId, 0);
      console.log(`  scheduler: analyzed "${sch.name}" → ${r.recommended ?? 0} recommended`);
    } catch (e) { console.log(`  scheduler: analysis failed for "${sch.name}": ${e.message}`); }
  }
  sch.lastRunAt = new Date().toISOString();
  sch.lastError = null;
}

let ticking = false;
async function schedulerTick(){
  if (ticking) return;                    // never overlap runs
  ticking = true;
  try {
    const schedules = await getSchedules();
    const now = Date.now();
    let changed = false;
    for (const sch of schedules){
      if (!sch.nextRun || new Date(sch.nextRun).getTime() > now) continue;
      try {
        await runDueSchedule(sch);
        // advance by the ICP's frequency, skipping any missed cycles
        const step = intervalMs(sch);
        let next = new Date(sch.nextRun).getTime();
        while (next <= Date.now()) next += step;
        sch.nextRun = new Date(next).toISOString();
      } catch (e) {
        sch.lastError = e.message;
        sch.nextRun = new Date(now + 10 * 60 * 1000).toISOString();   // retry in 10 min
        console.log(`  scheduler: "${sch.name}" failed — ${e.message} (retry in 10m)`);
      }
      changed = true;
    }
    if (changed) await saveSchedules(schedules);
  } catch (e) {
    console.log('  scheduler tick error:', e.message);
  } finally { ticking = false; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  /* ---------- offer store ---------- */
  if (url.pathname === '/data/offers') {
    if (req.method === 'GET') return send(res, 200, JSON.stringify(await getOffers()));
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body)) return send(res, 400, JSON.stringify({ error:'expected an array' }));
      await saveOffers(body);
      return send(res, 200, JSON.stringify({ ok:true, count: body.length }));
    }
    return send(res, 405, JSON.stringify({ error:'method not allowed' }));
  }

  /* ---------- leads store ---------- */
  if (url.pathname === '/data/leads') {
    if (req.method === 'GET') return send(res, 200, JSON.stringify(await getLeads()));
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body)) return send(res, 400, JSON.stringify({ error:'expected an array' }));
      await saveLeads(body);
      return send(res, 200, JSON.stringify({ ok:true, count: body.length }));
    }
    return send(res, 405, JSON.stringify({ error:'method not allowed' }));
  }

  /* ---------- schedules store ---------- */
  if (url.pathname === '/data/schedules') {
    if (req.method === 'GET') return send(res, 200, JSON.stringify(await getSchedules()));
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body)) return send(res, 400, JSON.stringify({ error:'expected an array' }));
      await saveSchedules(body);
      return send(res, 200, JSON.stringify({ ok:true, count: body.length }));
    }
    return send(res, 405, JSON.stringify({ error:'method not allowed' }));
  }

  /* ---------- analyze ---------- */
  if (url.pathname.startsWith('/analyze/') && req.method === 'POST') {
    const offerId = url.pathname.slice('/analyze/'.length);
    const max = Number(url.searchParams.get('max')) || 0;
    console.log(`  POST /analyze/${offerId} (max ${max || 'all'})`);
    try {
      const result = await analyzeOffer(offerId, max);
      return send(res, result.error ? 400 : 200, JSON.stringify(result));
    } catch (e) {
      console.log('  analyze failed:', e.message);
      return send(res, 500, JSON.stringify({ error: e.message }));
    }
  }

  /* ---------- Trigify proxy ---------- */
  if (url.pathname.startsWith('/api/')) {
    const target = TRIGIFY + url.pathname.slice(4) + url.search;
    let body = '';
    if (req.method !== 'GET' && req.method !== 'HEAD') for await (const c of req) body += c;
    try {
      const r = await fetch(target, {
        method: req.method,
        headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
        body: body || undefined
      });
      const text = await r.text();
      console.log(`  ${req.method} ${url.pathname} → ${r.status}`);
      return send(res, r.status, text);
    } catch (e) {
      return send(res, 502, JSON.stringify({ error:{ message:String(e.message) } }));
    }
  }

  /* ---------- static ---------- */
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = normalize(p).replace(/^(\.\.[\/\\])+/, '');
  try {
    const buf = await readFile(join(ROOT, p));
    return send(res, 200, buf, MIME[extname(p)] || 'application/octet-stream');
  } catch {
    return send(res, 404, 'Not found', 'text/plain');
  }
});

try {
  await initDb();
  console.log(`\n  storage: ${usingDb ? 'Postgres (DATABASE_URL)' : 'local JSON files (data/)'}`);
} catch (e) {
  console.error('  DB init failed:', e.message);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`  Kairos → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  analysis: ${anthropic ? 'ready (' + MODEL + ')' : 'DISABLED — ANTHROPIC_API_KEY not set'}`);
  // scheduler: check every minute for ICPs whose run time has arrived
  setInterval(schedulerTick, 60 * 1000);
  schedulerTick();
  console.log(`  scheduler: on (checks every 60s)\n`);
});
