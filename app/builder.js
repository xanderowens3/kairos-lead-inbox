/* ==========================================================================
   Kairos — ICP builder (a Trigify listening search, scoped to an offer)
   ========================================================================== */
import { TYPES, PLATFORMS, ICONS, FREQUENCY, TIME_FRAME, LI_SORT, LI_CONTENT,
         buildPayload, blank, verifyResults } from './schema.js';
import { loadOffers, offers, offerById, attachSearch, detachSearch,
         thresholdFor, setThreshold, offerForSearch } from './offers.js';
import { addSchedule, loadSchedules, allSchedules, cancelSchedule } from './schedules.js';
import { initOffers, renderOffers, renderOffer, scheduleStripHTML } from './views-offers.js';
import { initLeads, renderInbox, renderLeads } from './views-leads.js';
import { loadLeads, countInbox, leadsForIcp, isRecommended,
         promoteLead, pinGolden, rateLead, leadById } from './leads.js';
import { confirmDialog } from './modal.js';

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const pretty = v => cap(String(v).replace(/[-_]/g,' '));

let s = blank();
let searches = [];
let apiError = null, lastError = null;
let results = {}, expanded = {}, showMore = false;
const pad2 = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const todayISO = () => isoDate(new Date());
/* default first run: the next whole hour from now (always in the future) */
function defaultSched(){
  const d = new Date(Date.now() + 3600e3); d.setMinutes(0, 0, 0);
  return { mode: 'now', date: isoDate(d), time: `${pad2(d.getHours())}:00` };
}
const FREQ_LABEL = { 'hourly':'every hour', 'every-12h':'every 12 hours', 'daily':'every day',
  'weekly':'every week', 'monthly':'every month', 'quarterly':'every 3 months' };
let sched = defaultSched();          // ICP run scheduling (builder state)
let schedValid = true;               // is the chosen date+time in the future?
let icpOpen = {}, icpLoading = {}, icpView = {}, details = {};   // per-ICP state

/* The list endpoint returns only a summary (no query/filters), so fetch each
   ICP's DETAIL for its keywords/config and subtitle. Also pre-fetch results:
   Trigify's total_results counter over-reports (39 vs the 36 actually served),
   so the real count is the results array length. Both are free GETs, parallel. */
export async function ensureIcpData(ids){
  await Promise.all((ids || []).map(async id => {
    const jobs = [];
    if (!details[id]) jobs.push(api(`/searches/${id}`).then(r => { if (r.ok) details[id] = r.body.data; }));
    if (!results[id]) jobs.push(api(`/searches/${id}/results?limit=100`).then(r => { if (r.ok) results[id] = r.body.data ?? []; }));
    await Promise.all(jobs);
  }));
}
const full = x => details[x.id] || x;   // prefer the detailed object when loaded
const postCount = id => results[id] ? results[id].length : 0;

/* Trigify has no "next run" field — derive it from the last run + frequency. */
const INTERVAL_MS = { hourly:36e5, 'every-12h':432e5, daily:864e5,
                      weekly:6048e5, monthly:2592e6, quarterly:7776e6 };
function nextRunAt(x){
  if (x.status === 'paused') return null;
  const last = x.last_result_at ? new Date(x.last_result_at).getTime() : null;
  const iv = INTERVAL_MS[x.filters?.frequency];
  return (last && iv) ? new Date(last + iv) : null;
}
function relTime(date, future){
  if (!date) return null;
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = future ? d.getTime() - Date.now() : Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1)  return future ? 'any moment' : 'just now';
  if (min < 60) return future ? `in ${min} min` : `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24)   return future ? `in ${h}h` : `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return future ? `in ${days}d` : `${days}d ago`;
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
}
const exactTime = d => d ? new Date(d).toLocaleString('en-GB',
  { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
let currentOffer = null;

const api = async (path, opts={}) => {
  const r = await fetch('/api' + path, {
    ...opts, headers:{ 'content-type':'application/json', ...(opts.headers||{}) }
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw:text }; }
  return { ok:r.ok, status:r.status, body };
};

function toast(m, bad){ const t=$('#toast'); $('#toastMsg').textContent=m;
  t.classList.toggle('bad', !!bad); t.classList.add('up');
  clearTimeout(t._x); t._x=setTimeout(()=>t.classList.remove('up'), 3000); }

const isPerson = u => /linkedin\.com\/in\//i.test(u || '') || !/linkedin\.com/i.test(u || '');

/* ---------------- ROUTER ---------------- */
function go(v, arg){
  $$('.nav a').forEach(a => a.classList.toggle('on',
    a.dataset.view === v
    || ((v === 'build' || v === 'offer') && a.dataset.view === 'offers')));
  if (v === 'inbox'){ currentOffer = null; return renderInbox(); }
  if (v === 'leads'){ currentOffer = null; return renderLeads(); }
  if (v === 'offers'){ currentOffer = null; return renderOffers(); }
  if (v === 'offer'){  currentOffer = null; return renderOffer(arg); }
  if (v === 'list'){   currentOffer = null; return renderList(); }
  currentOffer = arg ?? null;
  sched = defaultSched();   // fresh scheduling defaults per new build
  renderBuild();
}
$$('.nav a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); go(a.dataset.view); }));

/* ==========================================================================
   ICP BUILDER
   ========================================================================== */
function renderBuild(){
  const t = TYPES[s.monitoring_type];
  const platform = t.platform;
  const inPlatform = Object.entries(TYPES).filter(([,v]) => v.platform === platform);
  const off = currentOffer ? offerById(currentOffer) : null;

  const main = $('#main');
  main.dataset.view = 'build';
  main.innerHTML = `
    <div class="topbar">
      ${off ? `<button class="back" id="back">&larr; ${esc(off.name)}</button>` : ''}
      <h1>New <em>ICP</em></h1>
      <div class="sub">${off
        ? `A listening search for <b>${esc(off.name)}</b>. Everything it collects is judged against that offer.`
        : `Not attached to an offer, so nothing collected will be qualified. Start from an offer instead.`}</div>
      <div class="swash"></div>
    </div>

    <div class="scroll"><div class="form-in">

      <section class="sec">
        <div class="sec-h"><span class="sec-n">1</span><h2>Where to <em>listen</em></h2></div>
        <div class="sec-b">
          <div class="plats">${PLATFORMS.map(p =>
            `<div class="plat ${p===platform?'on':''}" data-plat="${esc(p)}">
              <div class="g">${ICONS[p]||'·'}</div><div class="n">${esc(p)}</div></div>`).join('')}</div>
          ${inPlatform.length > 1 ? `<div class="types">${inPlatform.map(([k,v]) =>
            `<button class="type ${k===s.monitoring_type?'on':''}" data-type="${k}">${esc(v.label)}</button>`).join('')}</div>` : ''}
        </div>
      </section>

      <section class="sec">
        <div class="sec-h"><span class="sec-n">2</span><h2>What to <em>match</em></h2></div>
        <div class="sec-b">${queryFields(t)}</div>
      </section>

      <section class="sec">
        <div class="sec-h"><span class="sec-n">3</span><h2>Who and <em>when</em></h2></div>
        <div class="sec-b">${filterFields(t)}</div>
      </section>

      <section class="sec">
        <div class="sec-h"><span class="sec-n">4</span><h2>Name <em>it</em></h2></div>
        <div class="sec-b"><div class="field">
          <input type="text" id="f_name" value="${esc(s.name)}" placeholder="Agency hiring intent">
        </div></div>
      </section>

      ${off ? `<section class="sec">
        <div class="sec-h"><span class="sec-n">5</span><h2>When to <em>run</em></h2></div>
        <div class="sec-b">
          <div class="runmodes">
            <button type="button" class="runmode ${sched.mode==='now'?'on':''}" data-mode="now">
              <b>Run now</b><span>Start collecting immediately</span></button>
            <button type="button" class="runmode ${sched.mode==='daily'?'on':''}" data-mode="daily">
              <b>Schedule</b><span>Pick the date &amp; time of the first run</span></button>
          </div>
          <div class="sched-when" style="display:${sched.mode==='daily'?'block':'none'}">
            <div class="grid2">
              <div class="field"><label>Start date</label>
                <input type="date" id="f_rundate" value="${sched.date}" min="${todayISO()}"></div>
              <div class="field"><label>Start time</label>
                <input type="time" id="f_runtime" value="${sched.time}"></div>
            </div>
            <p class="sched-summary" id="schedSummary"></p>
            <p class="hint">Nothing is collected — and no credits are spent — until the first run.</p>
          </div>
        </div>
      </section>` : ''}

      <div class="submit">
        ${lastError ? `<div class="err">${esc(lastError)}</div>` : ''}
        <p class="cost" id="costNote"></p>
        <button class="btn btn-p lg" id="create">Create ICP</button>
      </div>
    </div></div>`;

  $('#back')?.addEventListener('click', () => go('offer', currentOffer));
  bind(); paint();
}

function queryFields(t){
  if (t.mode === 'profile') return `
    <div class="field"><label>Profile link</label>
      <input type="text" id="f_profile" value="${esc(s.profile_url)}"
        placeholder="${esc(t.urlHint || 'https://www.linkedin.com/in/username')}">
      <p class="hint">Everything this account publishes will be collected.</p></div>`;
  if (t.mode === 'publication') return `
    <div class="field"><label>${esc(t.pubLabel || 'Publication')}</label>
      <input type="text" id="f_pub" value="${esc(s.publication)}" placeholder="${esc(t.pubHint || '')}"></div>`;
  const andHint = s.keywords_and.length >= 2
    ? 'A post must contain <b>every</b> keyword you add here. Trigify does not always enforce this once there are two or more — this app checks every result itself and hides anything that does not truly match, so what you see is always accurate.'
    : 'A post must contain <b>every</b> keyword you add here.';
  return `
    ${tagField('keywords_and','Keywords','and','referrals dried up', andHint)}
    ${tagField('keywords_not','Exclude','not','apply here',
      'A post is thrown away if it contains one of these as a <b>whole word</b>. "India" removes "India" but not "Indian" — add both if you want the variants gone too.')}`;
}

function tagField(key, label, cls, ph, hint){
  return `<div class="field">
    <label>${label}</label>
    <input type="text" data-tag="${key}" placeholder="${esc(ph)}" autocomplete="off">
    ${s[key].length ? `<div class="tagrow">${s[key].map((v,i)=>
      `<span class="tag ${cls}">${esc(v)}<b data-rm="${key}" data-i="${i}">&times;</b></span>`).join('')}</div>` : ''}
    ${hint ? `<p class="hint">${hint} <span class="ret">Press Enter to add</span></p>` : ''}
  </div>`;
}

function filterFields(t){
  const sel = (id, val, opts, blankLabel) => `<select id="${id}">
    ${blankLabel ? `<option value=""${val?'':' selected'}>${blankLabel}</option>` : ''}
    ${opts.map(o=>`<option value="${o}"${o===val?' selected':''}>${pretty(o)}</option>`).join('')}</select>`;
  return `
    ${t.li ? tagField('job_titles','Job titles','who','Founder',
      'Only people with these titles. The most effective way to remove job boards and juniors.') : ''}
    <div class="grid2">
      <div class="field"><label>Check for new posts</label>${sel('f_freq', s.frequency, FREQUENCY)}</div>
      <div class="field"><label>Look back over</label>${sel('f_time', s.time_frame, TIME_FRAME, 'Any time')}</div>
    </div>
    ${t.li ? `<div class="grid2">
      <div class="field"><label>Order results by</label>${sel('f_sort', s.linkedin_sort_by, LI_SORT)}
        <p class="hint"><b>Relevance</b> surfaces the best-matching posts. <b>Date&nbsp;posted</b> shows the newest first — noisier, for real-time monitoring.</p></div>
      <div class="field"><label>Maximum results</label>
        <input type="number" id="f_max" value="${esc(s.max_results)}" placeholder="No limit" min="10" max="100">
        <p class="hint">10&ndash;100. Each result collected costs a credit.</p></div>
    </div>` : `<div class="field"><label>Maximum results</label>
      <input type="number" id="f_max" value="${esc(s.max_results)}" placeholder="No limit" min="10" max="100">
      <p class="hint">10&ndash;100. Each result collected costs a credit.</p></div>`}
    ${t.li ? `<button class="more-t" id="moreBtn">${showMore?'&minus; Fewer options':'+ More options'}</button>
    <div class="more-b" style="display:${showMore?'block':'none'}">
      <div class="field"><label>Post type</label>${sel('f_ctype', s.content_type, LI_CONTENT, 'Any')}</div>
      ${tagField('mentions_member','Posts tagging a person','who','profile link','')}
      ${tagField('mentions_organization','Posts tagging a company','who','company link','')}
    </div>` : ''}`;
}

function bind(){
  $$('.plat').forEach(el => el.addEventListener('click', () => {
    s.monitoring_type = Object.entries(TYPES).find(([,v]) => v.platform === el.dataset.plat)[0];
    renderBuild();
  }));
  $$('.type').forEach(el => el.addEventListener('click', () => {
    s.monitoring_type = el.dataset.type; renderBuild();
  }));
  $('#moreBtn')?.addEventListener('click', () => {
    showMore = !showMore;                       // toggle in place — no re-render, no scroll jump
    const box = document.querySelector('.more-b');
    if (box) box.style.display = showMore ? 'block' : 'none';
    $('#moreBtn').innerHTML = showMore ? '− Fewer options' : '+ More options';
  });

  $$('[data-tag]').forEach(inp => inp.addEventListener('keydown', e => {
    const key = inp.dataset.tag;
    if (e.key === 'Enter' || e.key === ','){
      e.preventDefault();
      const v = inp.value.trim().replace(/,+$/,''); if (!v) return;
      if (s[key].some(x => x.toLowerCase() === v.toLowerCase())){
        inp.value=''; inp.classList.add('dupe');
        setTimeout(()=>inp.classList.remove('dupe'),450);
        toast(`"${v}" is already added`, true); return;
      }
      s[key].push(v); inp.value=''; refresh(key, inp);
    }
    if (e.key === 'Backspace' && !inp.value && s[key].length){ s[key].pop(); refresh(key, inp); }
  }));
  $$('[data-rm]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.rm; s[key].splice(+b.dataset.i,1);
    refresh(key, document.querySelector(`[data-tag="${key}"]`));
  }));

  const on = (id,key) => { const el=$('#'+id); if (el)
    el.addEventListener('input', () => { s[key]=el.value; paint(); }); };
  on('f_name','name'); on('f_profile','profile_url'); on('f_pub','publication');
  on('f_freq','frequency'); on('f_time','time_frame'); on('f_ctype','content_type');
  on('f_sort','linkedin_sort_by'); on('f_max','max_results');

  $$('.runmode').forEach(b => b.addEventListener('click', () => {
    sched.mode = b.dataset.mode;
    $$('.runmode').forEach(x => x.classList.toggle('on', x === b));
    const when = document.querySelector('.sched-when');
    if (when) when.style.display = sched.mode === 'daily' ? 'block' : 'none';
    updateSchedSummary();
  }));
  $('#f_rundate')?.addEventListener('input', e => { sched.date = e.target.value; syncTimeMin(); updateSchedSummary(); });
  $('#f_runtime')?.addEventListener('input', e => { sched.time = e.target.value; updateSchedSummary(); });
  $('#f_freq')?.addEventListener('change', updateSchedSummary);   // recurrence text follows frequency
  syncTimeMin(); updateSchedSummary();

  $('#create')?.addEventListener('click', create);
}

/* the chosen first run as a Date, or null if incomplete/invalid */
function runDateTime(){
  if (!sched.date || !sched.time) return null;
  const d = new Date(`${sched.date}T${sched.time}`);
  return isNaN(d) ? null : d;
}

/* if the start date is today, the time can't be earlier than now */
function syncTimeMin(){
  const rt = $('#f_runtime'); if (!rt) return;
  if (sched.date === todayISO()){
    const n = new Date();
    rt.min = `${pad2(n.getHours())}:${pad2(n.getMinutes())}`;
  } else rt.removeAttribute('min');
}

/* Validate the future-only rule and write the plain-language summary. */
function updateSchedSummary(){
  const d = runDateTime();
  schedValid = !!(d && d.getTime() > Date.now());
  const el = $('#schedSummary');
  if (el){
    if (!d){
      el.className = 'sched-summary bad';
      el.textContent = 'Pick a start date and time.';
    } else if (!schedValid){
      el.className = 'sched-summary bad';
      el.textContent = 'That moment has already passed — pick a later date or time.';
    } else {
      el.className = 'sched-summary';
      const dateStr = d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
      const timeStr = d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
      const label = FREQ_LABEL[s.frequency] || 'every day';
      const anchored = ['daily','weekly','monthly','quarterly'].includes(s.frequency) ? ` at ${timeStr}` : '';
      el.innerHTML = `On <b>${dateStr}</b> this will first trigger at <b>${timeStr}</b>, `
        + `and from that point on it will trigger <b>${label}</b>${anchored}.`;
    }
  }
  paint();
}

const tagCls = k => k==='keywords_and'?'and' : k==='keywords_not'?'not' : 'who';

function refresh(key, inp){
  const field = inp.closest('.field');
  const row = field.querySelector('.tagrow');
  const html = s[key].map((v,i)=>
    `<span class="tag ${tagCls(key)}">${esc(v)}<b data-rm="${key}" data-i="${i}">&times;</b></span>`).join('');
  if (row){ html ? row.innerHTML = html : row.remove(); }
  else if (html) inp.insertAdjacentHTML('afterend', `<div class="tagrow">${html}</div>`);
  field.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    s[key].splice(+b.dataset.i,1); refresh(key, inp);
  }));
  inp.focus(); paint();
}

function paint(){
  const t = TYPES[s.monitoring_type];
  const ready = t.mode === 'keywords' ? s.keywords_and.length > 0
              : t.mode === 'profile'  ? !!s.profile_url : !!s.publication;
  const capN = Number(s.max_results) || 0;
  const note = $('#costNote');
  if (note) note.innerHTML = capN
    ? `1 credit to create, plus 1 for every result collected — up to <b>${capN+1} credits</b>.`
    : `1 credit to create, plus 1 for every result collected. Set a maximum to cap it.`;
  const scheduling = sched.mode === 'daily' && currentOffer;
  const canSubmit = ready && (!scheduling || schedValid);
  const btn = $('#create');
  if (btn){ btn.disabled = !canSubmit;
    btn.textContent = ready ? (scheduling ? 'Schedule ICP' : 'Create ICP')
      : t.mode === 'keywords' ? 'Add at least one keyword' : 'Fill in the field above'; }
}

async function create(){
  if (sched.mode === 'daily' && currentOffer) return scheduleIcp();
  const btn = $('#create');
  btn.disabled = true; btn.textContent = 'Creating…';
  lastError = null;
  const { ok, body } = await api('/searches', { method:'POST', body: JSON.stringify(buildPayload(s)) });
  if (ok){
    const id = body?.data?.id;
    const back = currentOffer;
    if (back && id) await attachSearch(back, id);
    toast('ICP created');
    s = blank(); sched = defaultSched();
    await loadSearches(); loadCredits();
    back ? go('offer', back) : go('list');
  } else {
    const issues = body?.error?.details?.issues;
    lastError = issues ? issues.map(i => i.message).join('\n')
                       : (body?.error?.message || body?.message || 'Request failed');
    toast('Not created', true); renderBuild();
  }
}

/* Schedule the ICP instead of creating it now: store the Trigify payload + a
   daily time. The server's scheduler creates it and runs analysis at that time. */
async function scheduleIcp(){
  const runDate = runDateTime();
  if (!runDate || runDate.getTime() <= Date.now()){ updateSchedSummary(); return; }
  const btn = $('#create'); btn.disabled = true; btn.textContent = 'Scheduling…';
  const off = offerById(currentOffer);
  const rec = {
    id: 'sch_' + Math.random().toString(36).slice(2, 10),
    offerId: currentOffer,
    offerName: off?.name || '',
    name: s.name || 'Untitled ICP',
    payload: buildPayload(s),
    frequency: s.frequency,
    timeOfDay: sched.time,
    nextRun: runDate.toISOString(),
    searchId: null,
    status: 'scheduled',
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastError: null
  };
  const ok = await addSchedule(rec);
  if (ok){
    toast('ICP scheduled');
    s = blank(); sched = defaultSched();
    go('offer', currentOffer);
  } else {
    toast('Could not schedule', true);
    btn.disabled = false; paint();
  }
}

/* ==========================================================================
   SEARCH ROWS — shared between the flat list and the offer view
   ========================================================================== */
export function rowHTML(row){
  const x = full(row);
  const q = x.query || {}, f = x.filters || {};
  const t = TYPES[q.monitoring_type || x.monitoring_type];
  const paused = x.status === 'paused';
  const open = !!icpOpen[x.id];
  const view = icpView[x.id] || 'results';
  const next = nextRunAt(x);
  const count = postCount(x.id);
  const loaded = !!details[x.id];

  return `<div class="icp-card${paused?' paused':''}${open?' open':''}">
    <div class="icp-top" data-open="${x.id}">
      <div class="icp-lead">
        <span class="icp-dot ${paused?'off':'on'}"></span>
        <div class="icp-namewrap">
          <span class="nm">${esc(x.name)}</span>
          <span class="icp-sub">${t ? esc(t.platform+' · '+t.label) : (loaded ? 'Unknown platform' : 'Loading…')}${f.frequency?` &middot; ${pretty(f.frequency)}`:''}</span>
        </div>
      </div>
      <div class="icp-ctrl">
        <button class="sw-w" data-toggle="${x.id}" data-cur="${esc(x.status||'')}"
          title="${paused?'Resume collecting':'Pause collecting'}">
          <span class="sw ${paused?'':'on'}"><i></i></span>
          <span class="sw-l">${paused?'Paused':'Live'}</span></button>
        <button class="icp-ico" data-config="${x.id}" title="View configuration" aria-label="View configuration">
          <svg viewBox="0 0 24 24"><path d="M4 6h11M4 12h16M4 18h7"/><circle cx="18" cy="6" r="2"/><circle cx="15" cy="18" r="2"/></svg>
        </button>
        <button class="icp-ico del" data-del="${x.id}" title="Delete ICP" aria-label="Delete ICP">
          <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m2 0v14a1 1 0 01-1 1H6a1 1 0 01-1-1V6"/></svg>
        </button>
      </div>
    </div>

    <div class="icp-stats" data-open="${x.id}">
      <div class="istat">
        <span class="iv iv-count">${count}</span>
        <span class="il">posts in last 24hrs</span></div>
      <div class="istat">
        <span class="iv">${relTime(x.last_result_at) ?? '—'}</span>
        ${x.last_result_at ? `<span class="iexact">${exactTime(x.last_result_at)}</span>` : ''}
        <span class="il">last run</span></div>
      <div class="istat">
        <span class="iv">${paused ? 'Paused' : next ? relTime(next, true) : 'pending'}</span>
        ${next && !paused ? `<span class="iexact">${exactTime(next)}</span>` : ''}
        <span class="il">next run</span></div>
    </div>

    ${open ? `<div class="icp-body">
      <div class="icp-tabs">
        <button class="itab ${view==='results'?'on':''}" data-tab="results" data-id="${x.id}">Results</button>
        <button class="itab ${view==='review'?'on':''}" data-tab="review" data-id="${x.id}">Review &amp; rank</button>
        <button class="itab ${view==='config'?'on':''}" data-tab="config" data-id="${x.id}">Configuration</button>
        ${view==='results' && results[x.id] ? `<button class="linkbtn icp-refresh" data-refresh="${x.id}">↻ Refresh</button>` : ''}
      </div>
      ${view === 'config' ? configHTML(x)
        : view === 'review' ? reviewHTML(x.id)
        : icpLoading[x.id] ? `<div class="res-loading">Loading results…</div>`
        : results[x.id] ? resultsHTML(results[x.id], q)
        : `<div class="res-empty">No results loaded.</div>`}
    </div>` : ''}
  </div>`;
}

/* Read-only view of every variable that defines the ICP. */
function configHTML(x){
  const q = x.query || {}, f = x.filters || {};
  const t = TYPES[q.monitoring_type];
  const chips = (arr, cls) => (arr||[]).length
    ? `<div class="cfg-chips">${arr.map(v => `<span class="kwc ${cls||''}">${esc(v)}</span>`).join('')}</div>`
    : `<span class="cfg-none">none</span>`;
  const row = (label, value) => `<div class="cfg-row"><span class="cfg-k">${label}</span>
    <span class="cfg-v">${value}</span></div>`;
  return `<div class="cfg">
    <div class="cfg-group"><h4>What it matches</h4>
      ${row('Required keywords', chips(q.keywords_and, 'and'))}
      ${q.keywords?.length ? row('Optional keywords', chips(q.keywords, 'or')) : ''}
      ${row('Excluded', chips(q.keywords_not, 'not'))}
      ${q.profile_url ? row('Profile', esc(q.profile_url)) : ''}
      ${q.publication ? row('Source', esc(q.publication)) : ''}
    </div>
    <div class="cfg-group"><h4>Who and where</h4>
      ${row('Platform', t ? `${esc(t.platform)} &middot; ${esc(t.label)}` : esc(q.monitoring_type||'?'))}
      ${f.job_titles?.length ? row('Job titles', chips(f.job_titles, 'who')) : row('Job titles', '<span class="cfg-none">any</span>')}
      ${row('Post type', f.content_type ? pretty(f.content_type) : '<span class="cfg-none">any</span>')}
    </div>
    <div class="cfg-group"><h4>Schedule &amp; scope</h4>
      ${row('Look back over', f.time_frame ? pretty(f.time_frame) : '<span class="cfg-none">any time</span>')}
      ${row('Checks for new posts', f.frequency ? pretty(f.frequency) : '<span class="cfg-none">—</span>')}
      ${row('Order results by', f.linkedin_sort_by ? pretty(f.linkedin_sort_by) : '<span class="cfg-none">default</span>')}
      ${row('Maximum results', f.max_results ? f.max_results : '<span class="cfg-none">no limit</span>')}
    </div>
  </div>`;
}

/* Review & rank: every post scored for this ICP, ranked, with the inbox line
   drawn at the ICP's threshold. Rate, promote below-threshold posts, pin golden. */
function reviewHTML(icpId){
  const leads = leadsForIcp(icpId);                 // score desc
  const thr = thresholdFor(icpId);
  const attached = !!offerForSearch(icpId);
  if (!attached) return `<div class="res-empty">This ICP isn't attached to an offer, so its posts aren't scored.</div>`;
  if (!leads.length) return `<div class="res-empty">No posts scored yet. Run analysis on the offer to fill the review queue.</div>`;
  const inInbox = leads.filter(isRecommended).length;
  return `<div class="rev">
    <div class="rev-thr">
      <div class="rev-thr-txt">
        <label>Inbox threshold</label>
        <p>Posts scoring <b class="thr-val" data-thrval="${icpId}">${thr}</b> or above go to the inbox
          &middot; <b>${inInbox}</b> of ${leads.length} qualify now.</p>
      </div>
      <input type="range" min="0" max="100" step="5" value="${thr}" class="rev-slider" data-thr="${icpId}">
    </div>
    <div class="rev-list">${leads.map(l => reviewRowHTML(l, thr)).join('')}</div>
  </div>`;
}

function reviewRowHTML(l, thr){
  const rec = isRecommended(l);
  const status = rec ? (l.promoted && l.score < thr ? 'promoted in' : 'in inbox') : 'below line';
  const promoteBtn = l.promoted
    ? `<button class="rev-btn on" data-promote="${l.id}">Promoted</button>`
    : (l.score < thr ? `<button class="rev-btn" data-promote="${l.id}">Promote</button>` : '');
  return `<div class="rev-row ${rec?'in':'out'}">
    <div class="rev-score ${rec?'in':''}">${l.score}</div>
    <div class="rev-main">
      <div class="rev-head">
        <span class="rev-name">${esc(l.author || 'Unknown')}</span>
        ${l.golden ? `<span class="rev-gold">★</span>` : ''}
        <span class="rev-status">${status}</span>
      </div>
      <div class="rev-reason">${esc(l.reason || '')}</div>
    </div>
    <div class="rev-acts">
      ${promoteBtn}
      <button class="rev-ic good ${l.rating==='good'?'on':''}" data-rate="good" data-rlead="${l.id}" title="Good fit">✓</button>
      <button class="rev-ic bad ${l.rating==='bad'?'on':''}" data-rate="bad" data-rlead="${l.id}" title="Not a fit">✕</button>
      <button class="rev-ic gold ${l.golden?'on':''}" data-gold="${l.id}" title="Pin as a permanent example">★</button>
    </div>
  </div>`;
}

export function bindRows(refreshView){
  // In-place row actions rebuild the view; keep the reader where they were
  // instead of snapping back to the top.
  const refresh = async () => {
    const y = document.querySelector('.scroll')?.scrollTop || 0;
    await refreshView();
    const sc = document.querySelector('.scroll');
    if (sc) sc.scrollTop = y;
  };
  // Click the header/stats to open the card (defaults to Results) — but not
  // when the click landed on a control button or inside the expanded body.
  $$('[data-open]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-toggle],[data-del],[data-config],[data-refresh],.icp-body')) return;
    openIcp(el.dataset.open, 'results', refresh);
  }));
  $$('[data-config]').forEach(x => x.addEventListener('click',
    e => { e.stopPropagation(); openIcp(x.dataset.config, 'config', refresh); }));
  $$('[data-tab]').forEach(x => x.addEventListener('click', e => {
    e.stopPropagation(); openIcp(x.dataset.id, x.dataset.tab, refresh);
  }));
  $$('[data-toggle]').forEach(x => x.addEventListener('click',
    e => { e.stopPropagation(); toggle(x.dataset.toggle, x.dataset.cur, x, refresh); }));
  $$('[data-del]').forEach(x => x.addEventListener('click',
    e => { e.stopPropagation(); del(x.dataset.del, refresh); }));
  $$('[data-refresh]').forEach(x => x.addEventListener('click',
    e => { e.stopPropagation(); pull(x.dataset.refresh, x, refresh); }));
  $$('[data-exp]').forEach(x => x.addEventListener('click', () => {
    expanded[x.dataset.exp] = !expanded[x.dataset.exp]; refresh();
  }));

  // review & rank actions
  $$('[data-thr]').forEach(sl => {
    sl.addEventListener('input', () => {
      const lbl = document.querySelector(`[data-thrval="${sl.dataset.thr}"]`);
      if (lbl) lbl.textContent = sl.value;
    });
    sl.addEventListener('change', async () => {
      await setThreshold(sl.dataset.thr, Number(sl.value));
      refresh();
    });
  });
  $$('[data-promote]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const l = leadById(b.dataset.promote);
    await promoteLead(b.dataset.promote, !l?.promoted);
    toast(l?.promoted ? 'Removed from inbox' : 'Promoted to inbox');
    syncInboxCount(); refresh();
  }));
  $$('[data-rate][data-rlead]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const l = leadById(b.dataset.rlead);
    const next = l?.rating === b.dataset.rate ? null : b.dataset.rate;
    await rateLead(b.dataset.rlead, next, l?.ratingNote, l?.userScore);
    refresh();
  }));
  $$('[data-gold]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const l = leadById(b.dataset.gold);
    await pinGolden(b.dataset.gold, !l?.golden);
    toast(l?.golden ? 'Unpinned' : 'Pinned as a permanent example');
    refresh();
  }));
}

async function openIcp(id, view, refresh){
  // Same tab clicked while open → collapse. Otherwise open to that tab.
  if (icpOpen[id] && (icpView[id] || 'results') === view){ icpOpen[id] = false; return refresh(); }
  icpOpen[id] = true;
  icpView[id] = view;
  if (view === 'review') await loadLeads();          // review reads the leads store
  if (view === 'results' && !results[id]){
    icpLoading[id] = true; await refresh();
    const { ok, body } = await api(`/searches/${id}/results?limit=100`);
    results[id] = ok ? (body.data ?? []) : [];
    icpLoading[id] = false; loadCredits();
  }
  refresh();
}

function resultsHTML(rows, query){
  if (!rows.length) return `<div class="res-empty">Nothing collected yet.</div>`;
  const { matched, dropped } = verifyResults(rows, query || {});
  const people = rows.filter(r => isPerson(r.author?.profile_url)).length;
  const hasKw = (query?.keywords_and?.length || query?.keywords?.length || query?.keywords_not?.length);
  // Everything Trigify returned is shown — full keyword matches first, then the
  // looser ones. Strong pain-point posts rarely use your exact words, so the
  // partial matches are often the better leads. Qualification is the real filter.
  return `<div class="res">
    <div class="res-h">${rows.length} collected &middot; ${people} from people, ${rows.length-people} from company pages
      ${hasKw ? `&middot; <b>${matched.length}</b> contain every keyword` : ''}</div>
    ${hasKw && dropped.length ? `<div class="res-note">
      The ${matched.length} with a <span class="mtag full">✓ all keywords</span> badge contain every
      term literally. The ${dropped.length} marked <span class="mtag part">partial</span> matched loosely —
      often the stronger leads, since good posts seldom use your exact phrasing. All are shown; the
      offer qualifier judges them on meaning, not wording.</div>` : ''}
    ${matched.map(r => cardHTML(r, true)).join('')}
    ${dropped.map(r => cardHTML(r, false)).join('')}
  </div>`;
}

function cardHTML(r, isFull){
  const person = isPerson(r.author?.profile_url);
  const text = r.content?.text || '';
  const open = expanded[r.id];
  const shown = open ? text : text.replace(/\s+/g,' ').slice(0,240);
  const when = r.published_at ? new Date(r.published_at).toLocaleString('en-GB',
    { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '—';
  const e = r.engagement || {};
  const mtag = isFull === undefined ? ''
    : isFull ? `<span class="mtag full">✓ all keywords</span>`
             : `<span class="mtag part">partial</span>`;
  return `<div class="res-c${isFull === false ? ' partial' : ''}">
    <div class="res-top">
      <span class="who">${esc(r.author?.name || 'Unknown')}</span>
      <span class="badge ${person?'p':'c'}">${person?'Person':'Company page'}</span>
      ${mtag}
      <span class="when">${esc(when)}</span></div>
    <div class="res-body${open?' open':''}">${esc(shown)}${!open && text.length>240?'…':''}</div>
    ${text.length > 240 ? `<button class="more" data-exp="${r.id}">${open?'Show less':'Show full post'}</button>` : ''}
    <div class="res-f">
      <a href="${esc(r.content?.url||'#')}" target="_blank" rel="noopener" class="lk">Open post &#8599;</a>
      ${r.author?.profile_url?`<a href="${esc(r.author.profile_url)}" target="_blank" rel="noopener" class="lk">Profile &#8599;</a>`:''}
      <span class="mut">${e.likes ?? 0} likes &middot; ${e.comments ?? 0} comments</span></div>
  </div>`;
}

async function toggle(id, current, el, refreshView){
  const next = current === 'paused' ? 'active' : 'paused';
  el.classList.add('busy');
  const { ok, body } = await api(`/searches/${id}`, { method:'PATCH', body: JSON.stringify({ status: next }) });
  el.classList.remove('busy');
  if (!ok) return toast(body?.error?.message || 'Could not change status', true);
  toast(next === 'paused' ? 'Paused — it will stop collecting' : 'Resumed — collecting again');
  delete details[id];                         // status changed — refetch fresh detail
  await loadSearches(); await ensureIcpData([id]); loadCredits(); refreshView();
}

async function pull(id, btn, refreshView){
  btn.textContent = 'Loading…'; btn.disabled = true;
  const { ok, body } = await api(`/searches/${id}/results?limit=100`);
  if (!ok){ btn.disabled=false; btn.textContent='Refresh'; return toast('Could not load results', true); }
  results[id] = body.data ?? [];
  loadCredits(); refreshView();
}

async function del(id, refreshView){
  const yes = await confirmDialog({
    title: 'Delete this ICP?',
    body: 'Its collected results go with it. This cannot be undone.',
    confirm: 'Delete', danger: true
  });
  if (!yes) return;
  const { ok } = await api(`/searches/${id}`, { method:'DELETE' });
  toast(ok ? 'Deleted' : 'Delete failed', !ok);
  if (ok){
    // drop the reference from any offer so no "ICP went missing" warning lingers
    for (const o of offers().filter(x => (x.searchIds || []).includes(id))){
      await detachSearch(o.id, id);
    }
  }
  delete results[id]; delete details[id];
  await loadSearches(); loadCredits(); refreshView();
}

/* ==========================================================================
   FLAT LIST
   ========================================================================== */
async function loadSearches(){
  const { ok, status, body } = await api('/searches');
  if (!ok){
    apiError = body?.error?.message || body?.message || `Trigify returned ${status}`;
    searches = []; $('#cnt').textContent = '!'; return;
  }
  apiError = null;
  searches = Array.isArray(body.data) ? body.data : [];
  $('#cnt').textContent = searches.length;
}

function renderList(){
  const main = $('#main');
  main.dataset.view = 'list';
  main.innerHTML = `
    <div class="topbar">
      <h1>All <em>ICPs</em></h1>
      <div class="sub">Every listening search on the account, including any not attached to an offer.</div>
      <div class="swash"></div>
    </div>
    <div class="scroll"><div class="list-in" id="listBody">${searches.length ? '' : '<div class="empty"><p>Loading…</p></div>'}</div></div>`;
  if (searches.length) paintList();          // instant from cache
  // load offers + schedules too, so ICP cards render exactly as in the offer view
  Promise.all([loadSearches(), loadOffers(), loadSchedules()])
    .then(() => ensureIcpData(searches.map(s => s.id)))
    .then(() => { if ($('#main')?.dataset.view === 'list') paintList(); });   // revalidate
}

function paintList(){
  const b = $('#listBody'); if (!b) return;
  if (apiError){
    b.innerHTML = `<div class="empty"><img src="icons/mark.svg" alt="">
      <div class="h">Trigify is <em>not responding</em></div><p>${esc(apiError)}</p></div>`;
    return;
  }
  if (!searches.length){
    b.innerHTML = `<div class="empty"><img src="icons/mark.svg" alt="">
      <div class="h">Nothing <em>listening</em> yet</div>
      <p>ICPs are created inside an offer, so the agent knows what to judge them against.</p></div>`;
    return;
  }
  // a created scheduled ICP gets the same merged strip it has in the offer view
  const bySearch = {};
  allSchedules().forEach(s => { if (s.searchId) bySearch[s.searchId] = s; });
  b.innerHTML = searches.map(s => {
    const sc = bySearch[s.id];
    return sc ? `<div class="icp-unit has-sched">${rowHTML(s)}${scheduleStripHTML(sc)}</div>` : rowHTML(s);
  }).join('');
  bindRows(paintList);
  // stop/cancel a schedule from the strip (offer view binds this itself)
  $$('[data-cancel]').forEach(btn => btn.addEventListener('click', async () => {
    const sc = allSchedules().find(x => x.id === btn.dataset.cancel);
    const created = !!sc?.searchId;
    const ok = await confirmDialog({
      title: created ? 'Stop this scheduled run?' : 'Cancel this scheduled ICP?',
      body: created
        ? 'Automatic runs will stop. The ICP and any leads it has produced stay.'
        : 'It will not be created or run. You can schedule it again later.',
      confirm: created ? 'Stop' : 'Cancel it', danger: true
    });
    if (!ok) return;
    await cancelSchedule(btn.dataset.cancel);
    toast(created ? 'Schedule stopped' : 'Schedule cancelled');
    refreshInboxCount(); renderList();
  }));
}

async function loadCredits(){
  const { ok, status, body } = await api('/usage');
  if (!ok){ $('#credits').textContent = `account unreadable — ${status}`; return; }
  const c = body.data?.credits, r = body.data?.results, m = body.data?.monitors;
  $('#credits').textContent =
    `${c?.total_consumed ?? '?'} credits used · ${r?.total_collected ?? 0} collected · ${m?.active ?? 0} active`;
}

/* ---------------- BOOT ---------------- */
function syncInboxCount(){                 // instant — counts the current cache
  const dot = $('#inboxCnt');
  if (dot) dot.textContent = countInbox() || '';
}
async function refreshInboxCount(){        // refetch, then sync (boot / after analysis)
  await loadLeads();
  syncInboxCount();
}
initOffers({ go, toast, rowHTML, bindRows, loadSearches, ensureIcpData,
             refreshInboxCount, syncInboxCount, get searches(){ return searches; } });
initLeads({ go, toast, refreshInboxCount, syncInboxCount });

await loadOffers();
await loadLeads();      // warm the leads cache so the first inbox paint is populated
loadSearches();         // Trigify data in the background — ICP/offer tabs revalidate on open
loadCredits();
syncInboxCount();
go('inbox');
