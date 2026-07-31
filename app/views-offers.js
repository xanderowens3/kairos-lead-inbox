/* ==========================================================================
   Offer views: list, detail (with its ICPs), editor
   ========================================================================== */
import { blankOffer, loadOffers, offers, offerById, upsertOffer, removeOffer,
         detachSearch, readiness, clampWeight, blankExamples, filledExamples,
         NEG_BANDS, POS_BANDS, SCORE_BANDS } from './offers.js';
import { TYPES } from './schema.js';
import { confirmDialog } from './modal.js';
import { loadSchedules, schedulesForOffer, cancelSchedule } from './schedules.js';

/* friendly "today/tomorrow at 9:00 AM", else "Mon, Jul 28 at 9:00 AM" */
const fmtWhen = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  const day = new Date(d); day.setHours(0,0,0,0);
  const t0 = new Date(); t0.setHours(0,0,0,0);
  const rel = day.getTime() === t0.getTime() ? 'today'
    : day.getTime() === t0.getTime() + 86400000 ? 'tomorrow'
    : d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  return `${rel} at ${d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}`;
};
const clockSvg = `<svg viewBox="0 0 24 24" class="sched-ic"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
const FREQ_LABEL = { 'hourly':'every hour', 'every-12h':'every 12 hours', 'daily':'every day',
  'weekly':'every week', 'monthly':'every month', 'quarterly':'every 3 months' };

function scheduledCardHTML(sc){
  const label = FREQ_LABEL[sc.frequency] || 'every day';
  const created = !!sc.searchId;
  const state = !created ? 'scheduled' : (sc.warming ? 'warming' : 'active');
  const stateLabel = { scheduled:'Scheduled', warming:'Warming up', active:'Active' }[state];

  const sub = !created
    ? `First run <b>${fmtWhen(sc.nextRun)}</b>, then <b>${label}</b>${sc.minScore != null ? ` · inbox at <b>${sc.minScore}+</b>` : ''}. Not collecting yet.`
    : `Runs <b>${label}</b> · next run <b>${fmtWhen(sc.nextRun)}</b>${sc.warming ? ' · waiting for first results' : ''}`;

  let outcome = '';
  if (sc.lastRunAt){
    outcome = sc.lastError
      ? `<div class="sched-err">Last run ${fmtWhen(sc.lastRunAt)} — ${esc(sc.lastError)}</div>`
      : `<div class="sched-out">Last run ${fmtWhen(sc.lastRunAt)} — <b>${sc.lastAnalyzed ?? 0}</b> analyzed, <b>${sc.lastRecommended ?? 0}</b> recommended</div>`;
  }

  return `<div class="sched-card ${state}">
    <div class="sched-l">
      ${clockSvg}
      <div>
        <div class="sched-name">${esc(sc.name || 'Untitled ICP')}<span class="sched-pill ${state}">${stateLabel}</span></div>
        <div class="sched-sub">${sub}</div>
        ${outcome}
      </div>
    </div>
    <button class="sched-cancel" data-cancel="${sc.id}">${created ? 'Stop' : 'Cancel'}</button>
  </div>`;
}

/* Is this schedule mid-run? Used to keep the view polling until it settles. */
export const isRunning = sc => sc.runState === 'collecting' || sc.runState === 'analyzing';

/* compact schedule status attached beneath a created ICP's row (merged unit).
   An ICP only reads as finished ("Ready") once the agent has scored everything. */
export function scheduleStripHTML(sc){
  const label = FREQ_LABEL[sc.frequency] || 'every day';
  const running = isRunning(sc);
  const state = sc.runState === 'collecting' ? 'warming'
              : sc.runState === 'analyzing' ? 'analyzing'
              : sc.runState === 'error' ? 'err' : 'active';
  const stateLabel = { warming:'Collecting', analyzing:'Analyzing', err:'Needs attention', active:'Ready' }[state];

  const body = running
    ? (sc.runState === 'collecting'
        ? `Collecting posts from Trigify — scoring starts once collection finishes.`
        : `Scoring every collected post — leads appear in your inbox once all are done.`)
    : `Runs <b>${label}</b> <span class="strip-sep">·</span> next <b>${fmtWhen(sc.nextRun)}</b>` + (
        sc.lastRunAt
          ? (sc.lastError
              ? `<span class="strip-sep">·</span><span class="sched-err">last run ${fmtWhen(sc.lastRunAt)}: ${esc(sc.lastError)}</span>`
              : `<span class="strip-sep">·</span>last run ${fmtWhen(sc.lastRunAt)}: <b>${sc.lastAnalyzed ?? 0}</b> scored, <b>${sc.lastRecommended ?? 0}</b> to inbox`)
          : '');

  return `<div class="sched-strip ${state}">
    ${running ? `<span class="strip-spin"></span>` : clockSvg}
    <div class="strip-txt">
      <span class="sched-pill ${state}">${stateLabel}</span>
      ${body}
    </div>
    <button class="sched-cancel sm" data-cancel="${sc.id}">Stop</button>
  </div>`;
}

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const pretty = v => cap(String(v).replace(/[-_]/g,' '));

let draft = null;
const openEg = new Set();        // which score-band example slots are expanded
let ctx = null;          // injected from builder.js: { go, toast, searches, loadSearches, del, toggle, pull, resultsHTML }

export function initOffers(c){ ctx = c; }

/* ══════════════ LIST ══════════════ */
export function renderOffers(){
  paintOffers();                       // instant from cache
  loadOffers().then(() => { if ($('#main')?.dataset.view === 'offers') paintOffers(); });
}
function paintOffers(){
  const main = $('#main'); if (!main) return;
  main.dataset.view = 'offers';
  const list = offers();
  main.innerHTML = `
    <div class="topbar">
      <h1>Your <em>offers</em></h1>
      <div class="sub">Each offer is the context the agent judges every post against.</div>
      <div class="swash"></div>
    </div>
    <div class="scroll"><div class="list-in">
      ${!list.length ? `<p class="offers-intro">An offer describes what you sell and who for.
        Every lead the agent scores is judged against it. Start one below.</p>` : ''}
      <div class="folders">
        ${list.map(cardHTML).join('')}
        <div class="folder new" id="newOffer">
          <div class="folder-in add-in">
            <svg class="folder-outline" viewBox="0 0 48 40" aria-hidden="true">
              <path d="M4 10a4 4 0 014-4h11l4 5h17a4 4 0 014 4v19a4 4 0 01-4 4H8a4 4 0 01-4-4V10z"/>
              <path class="plus-h" d="M24 18v10M19 23h10"/>
            </svg>
            <div class="folder-h">New offer</div>
            <div class="folder-d">Describe what you sell and who it's for.</div>
          </div>
        </div>
      </div>
    </div></div>`;
  $('#newOffer').addEventListener('click', () => { draft = blankOffer(); renderEditor(); });
  $$('[data-open]').forEach(e => e.addEventListener('click', () => renderOffer(e.dataset.open)));
}

function cardHTML(o){
  const r = readiness(o);
  const n = (o.searchIds || []).length;
  return `<div class="folder" data-open="${o.id}">
    <div class="tab"></div>
    <div class="folder-in">
      <div class="folder-h">${esc(o.name || 'Untitled offer')}</div>
      <div class="folder-d">${esc((o.sell || 'No description yet').slice(0,110))}${(o.sell||'').length>110?'…':''}</div>
      <div class="folder-f">
        <span><b>${n}</b> ICP${n===1?'':'s'}</span>
        <span class="sep">·</span>
        <span class="ready ${r.done===r.total?'full':''}">${r.done}/${r.total} context</span>
      </div>
    </div></div>`;
}

/* ══════════════ DETAIL ══════════════ */
export async function renderOffer(id){
  await loadOffers();
  const o = offerById(id);
  if (!o) return renderOffers();
  if (!ctx.searches.length) await ctx.loadSearches();

  const mine = (o.searchIds || [])
    .map(sid => ctx.searches.find(s => s.id === sid))
    .filter(Boolean);
  await ctx.ensureIcpData(mine.map(s => s.id));   // accurate post counts + instant expand
  await loadSchedules();
  const mySchedules = schedulesForOffer(id);
  const pending = mySchedules.filter(s => !s.searchId);          // not yet created → own card
  const schedBySearch = {};                                       // created → attached to its ICP row
  mySchedules.forEach(s => { if (s.searchId) schedBySearch[s.searchId] = s; });
  const r = readiness(o);
  const bullets = (arr, neg, pos) => (arr||[]).filter(Boolean).length
    ? `<ul class="bullets ${neg?'neg':''}${pos?'pos':''}">${arr.filter(Boolean).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`
    : `<p class="none">Not set</p>`;
  /* weighted list — heaviest signals first, since that is what drives the score */
  const wBullets = (arr, neg) => {
    const items = (arr || []).filter(x => x?.text).sort((a,b) => b.weight - a.weight);
    if (!items.length) return `<p class="none">Not set</p>`;
    return `<ul class="bullets ${neg?'neg':'pos'} weighted">${items.map(x =>
      `<li><span class="wchip ${neg?'neg':'pos'}">${clampWeight(x.weight)}</span>${esc(x.text)}</li>`).join('')}</ul>`;
  };

  const main = $('#main');
  main.dataset.view = 'offer';
  main.innerHTML = `
    <div class="topbar">
      <button class="back" id="back">&larr; All offers</button>
      <div class="offer-headrow">
        <h1>${esc(o.name || 'Untitled offer')}</h1>
        <button class="offer-del" id="delOffer" title="Delete this offer">
          <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m2 0v14a1 1 0 01-1 1H6a1 1 0 01-1-1V6"/></svg>
          Delete offer</button>
      </div>
      <div class="sub">${esc(o.sell || 'No description yet')}</div>
      <div class="swash"></div>
    </div>
    <div class="scroll"><div class="list-in">

      <div class="ctx">
        <div class="ctx-h">
          <h2>Context the <em>agent</em> reads</h2>
          <button class="btn btn-s sm" id="edit">Edit</button>
        </div>
        <div class="ctx-bar">
          <div class="ctx-track"><i style="width:${r.done/r.total*100}%"></i></div>
          <span>${r.done} of ${r.total} filled in</span>
        </div>
        <div class="ctx-grid">
          <div><h3>Who it is for</h3>
            <p class="prose">${esc(o.icpText) || '<span class="none">Not set</span>'}</p></div>
          <div><h3>Problems you solve for your customers</h3>${bullets(o.pains)}</div>
          <div><h3>ICP qualifiers</h3>${wBullets(o.qualifiers, false)}</div>
          <div><h3>ICP disqualifiers</h3>${wBullets(o.disqualifiers, true)}</div>
          ${filledExamples(o) ? `
          <div class="ctx-wide"><h3>Worked examples <span class="egcount">${filledExamples(o)} of ${SCORE_BANDS.length} bands</span></h3>
            <div class="egscale">${SCORE_BANDS.map(b => {
              const e = o.scoreExamples?.[b] || {};
              const on = !!(e.post||'').trim();
              return `<div class="egchip ${on ? (b>=60?'pos':'neg') : 'off'}" title="${on?esc((e.why||e.post).slice(0,120)):'No example'}">${b}</div>`;
            }).join('')}</div>
          </div>` : `
          <div><h3>Worked examples</h3>
            <p class="none">None yet — this is what defines the scale. A real post at each
              level teaches the difference between a 40 and an 80 better than any description.</p></div>`}
        </div>
      </div>

      <div class="icp-head icp-head-row">
        <div>
          <h2>ICPs</h2>
          <p>Each one is a listening search. At its scheduled time it collects posts, the agent
             scores every one of them, and anything clearing the ICP's threshold lands in your inbox.</p>
        </div>
      </div>

      <button class="add-icp" id="newIcp">
        <span class="add-icp-plus">+</span>
        <span><b>New ICP</b><span class="add-icp-sub">A listening search for this offer</span></span>
      </button>

      ${pending.map(scheduledCardHTML).join('')}
      ${mine.map(s => {
        const sc = schedBySearch[s.id];
        return sc
          ? `<div class="icp-unit has-sched">${ctx.rowHTML(s)}${scheduleStripHTML(sc)}</div>`
          : ctx.rowHTML(s);
      }).join('')}
    </div></div>`;

  $('#back').addEventListener('click', renderOffers);
  $('#edit').addEventListener('click', () => { draft = structuredClone(o); renderEditor(); });
  $('#newIcp').addEventListener('click', () => ctx.go('build', o.id));
  $$('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
    const sc = mySchedules.find(s => s.id === b.dataset.cancel);
    const created = !!sc?.searchId;
    const ok = await confirmDialog({
      title: created ? 'Stop this scheduled run?' : 'Cancel this scheduled ICP?',
      body: created
        ? 'Automatic runs will stop. The ICP and any leads it has produced stay.'
        : 'It will not be created or run. You can schedule it again later.',
      confirm: created ? 'Stop' : 'Cancel it', danger: true
    });
    if (!ok) return;
    await cancelSchedule(b.dataset.cancel);
    ctx.toast(created ? 'Schedule stopped' : 'Schedule cancelled');
    renderOffer(id);
  }));
  $('#delOffer').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: `Delete "${esc(o.name)}"?`,
      body: `Its ICPs stay in Trigify — only this offer's context is removed.`,
      confirm: 'Delete', danger: true
    });
    if (!ok) return;
    await removeOffer(id); ctx.toast('Offer deleted'); renderOffers();
  });
  ctx.bindRows(() => renderOffer(id));

  // while a run is in flight, keep the view live so it settles on its own
  clearTimeout(runPoll);
  if (mySchedules.some(isRunning)){
    runPoll = setTimeout(() => {
      if ($('#main')?.dataset.view === 'offer') renderOffer(id);
    }, 8000);
  }
}
let runPoll = null;

/* ══════════════ EDITOR ══════════════ */
export function renderEditor(){
  const o = draft;
  const lines = (key, ph) => ((o[key]?.length ? o[key] : [''])).map((v,i)=>`
    <div class="line"><input type="text" data-lk="${key}" data-i="${i}" value="${esc(v)}"
      placeholder="${esc(ph)}"><button class="x" data-lx="${key}" data-i="${i}">&times;</button></div>`).join('');

  /* qualifiers and disqualifiers carry a 1–10 weight alongside the text */
  const wLines = (key, ph) => {
    const arr = o[key]?.length ? o[key] : [{ text:'', weight:5 }];
    return arr.map((v,i) => `
      <div class="line wline">
        <input type="text" data-lk="${key}" data-i="${i}" value="${esc(v.text)}" placeholder="${esc(ph)}">
        <input type="number" class="wt" data-wk="${key}" data-i="${i}" min="1" max="10" step="1"
          value="${clampWeight(v.weight)}" aria-label="Importance from 1 to 10">
        <button class="x" data-lx="${key}" data-i="${i}">&times;</button>
      </div>`).join('');
  };

  /* one collapsible slot per score band, so the scale is defined by real posts */
  const egRow = b => {
    const e = o.scoreExamples?.[b] || { post:'', why:'' };
    const filled = !!(e.post || '').trim();
    const open = openEg.has(String(b));
    const preview = filled ? esc(e.post.replace(/\s+/g,' ').slice(0,64)) + '…' : 'Empty';
    return `<div class="egrow${filled?' filled':''}${open?' open':''}">
      <button type="button" class="eghead" data-egtoggle="${b}">
        <span class="egscore ${b>=60?'pos':'neg'}">${b}</span>
        <span class="egsum">${preview}</span>
        <span class="egchev">${open?'&minus;':'+'}</span>
      </button>
      ${open ? `<div class="egbody">
        <label>The post</label>
        <textarea data-eg="${b}" data-f="post" rows="4"
          placeholder="Paste the post exactly as it appeared…">${esc(e.post)}</textarea>
        <label>Why this is a ${b}</label>
        <textarea data-eg="${b}" data-f="why" rows="3"
          placeholder="Who posted it matters as much as what it says — say what tips it to ${b}…">${esc(e.why)}</textarea>
      </div>` : ''}
    </div>`;
  };

  const main = $('#main');
  main.dataset.view = 'editor';
  main.innerHTML = `
    <div class="topbar">
      <button class="back" id="back">&larr; Cancel</button>
      <h1>${o.name ? 'Edit' : 'New'} <em>offer</em></h1>
      <div class="sub">Everything here is injected into the prompt that judges each post.</div>
      <div class="swash"></div>
    </div>
    <div class="scroll"><div class="form-in">

      <div class="field"><label>Offer name</label>
        <input type="text" id="o_name" value="${esc(o.name)}" placeholder="Done-for-you cold email"></div>

      <div class="field"><label>What you sell</label>
        <textarea id="o_sell" rows="4" placeholder="A fully managed outbound layer for…">${esc(o.sell)}</textarea>
        <p class="hint">Describe it the way you would to someone in your industry, not the way it reads on your website.</p></div>

      <div class="field"><label>Who it is for</label>
        <textarea id="o_icp" rows="5" placeholder="Founders and managing directors of digital marketing agencies with 5 to 40 staff…">${esc(o.icpText)}</textarea>
        <p class="hint">Write freely. Anything you would tell a new salesperson on their first day belongs here.</p></div>

      <div class="field"><label>Problems you solve for your customers</label>
        <div class="lines" id="pains">${lines('pains','Delivery crowds out new business entirely')}</div>
        <button class="add" data-add="pains">+ Add another</button>
        <p class="hint">In the words a buyer would use, not the words you would sell against them.</p></div>

      <div class="field"><label>ICP qualifiers <span class="wthead">importance</span></label>
        <div class="lines" id="qual">${wLines('qualifiers','Already running outbound but getting poor results')}</div>
        <button class="add" data-add="qualifiers">+ Add another</button>
        <p class="hint">Signals that make a lead <b>more qualified</b>. Score each <b>1&ndash;10</b> for how much
          it should matter — 10 is the strongest thing to look for, 1 is close to irrelevant.</p></div>

      <div class="field"><label>ICP disqualifiers <span class="wthead">importance</span></label>
        <div class="lines" id="disq">${wLines('disqualifiers','Anyone selling the same service — competitors')}</div>
        <button class="add" data-add="disqualifiers">+ Add another</button>
        <p class="hint">Signals that count <b>against</b> a lead. Score each <b>1&ndash;10</b> for how heavily it
          should weigh — 10 is close to disqualifying, 1 is a mild reservation.</p></div>

      <div class="egbox">
        <h3>Worked examples <span>— what defines the scale</span></h3>
        <p>Give the agent a real post at each level. This is what tells it the difference
           between a 40 and an 80 — without it, scores drift toward the middle. Say <b>why</b>
           each one sits where it does; often that is about <b>who</b> is posting, not the words.</p>

        <h4 class="eggrp neg">Lower scores &middot; 10&ndash;50</h4>
        ${NEG_BANDS.map(egRow).join('')}

        <h4 class="eggrp pos">Higher scores &middot; 60&ndash;100</h4>
        ${POS_BANDS.map(egRow).join('')}
      </div>

      <div class="submit">
        <button class="btn btn-p lg" id="save">Save offer</button>
      </div>
    </div></div>`;

  $('#back').addEventListener('click', () => draft.searchIds?.length || offerById(draft.id)
    ? renderOffer(draft.id) : renderOffers());

  const collect = () => {
    o.name  = $('#o_name').value.trim();
    o.sell  = $('#o_sell').value.trim();
    o.icpText = $('#o_icp').value.trim();
    o.pains = $$('[data-lk="pains"]').map(i => i.value.trim());
    ['qualifiers','disqualifiers'].forEach(k => {
      const weights = $$(`[data-wk="${k}"]`);
      o[k] = $$(`[data-lk="${k}"]`).map((inp, i) => ({
        text: inp.value.trim(), weight: clampWeight(weights[i]?.value)
      }));
    });
    o.scoreExamples = o.scoreExamples || blankExamples();
    $$('[data-eg]').forEach(t => {
      const b = t.dataset.eg;
      o.scoreExamples[b] = o.scoreExamples[b] || { post:'', why:'' };
      o.scoreExamples[b][t.dataset.f] = t.value;
    });
  };

  // re-render the editor without snapping scroll back to the top
  const reRender = () => {
    const y = document.querySelector('.scroll')?.scrollTop || 0;
    renderEditor();
    const sc = document.querySelector('.scroll');
    if (sc) sc.scrollTop = y;
  };
  $$('[data-add]').forEach(b => b.addEventListener('click', () => {
    collect(); o[b.dataset.add].push(''); reRender();
    const r = $$(`[data-lk="${b.dataset.add}"]`); r[r.length-1]?.focus();
  }));
  $$('[data-lx]').forEach(b => b.addEventListener('click', () => {
    collect(); const k = b.dataset.lx;
    o[k].splice(+b.dataset.i, 1);
    if (!o[k].length) o[k] = k === 'pains' ? [''] : [{ text:'', weight:5 }];
    reRender();
  }));
  // keep weights inside 1–10 however they are typed or pasted
  $$('[data-wk]').forEach(w => w.addEventListener('change', () => {
    w.value = clampWeight(w.value);
  }));
  $$('[data-egtoggle]').forEach(b => b.addEventListener('click', () => {
    const band = b.dataset.egtoggle;
    collect();
    openEg.has(band) ? openEg.delete(band) : openEg.add(band);
    reRender();
  }));

  $('#save').addEventListener('click', async () => {
    collect();
    o.pains = o.pains.filter(Boolean);
    o.qualifiers    = (o.qualifiers || []).filter(q => q.text);
    o.disqualifiers = (o.disqualifiers || []).filter(q => q.text);
    o.name = o.name || 'Untitled offer';
    const ok = await upsertOffer(o);
    ctx.toast(ok ? 'Offer saved' : 'Could not save', !ok);
    if (ok) renderOffer(o.id);
  });
}
