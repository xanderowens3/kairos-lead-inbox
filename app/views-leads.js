/* ==========================================================================
   Inbox + Leads: a scrollable list on the left. Clicking a lead opens a
   detail panel on the right (closed until a lead is clicked).
   ========================================================================== */
import { loadLeads, recommended, contactedLeads, inbox, leadById, rateLead, markContacted,
         deleteLead, pinGolden, isRecommended } from './leads.js';
import { loadOffers, thresholdFor } from './offers.js';
import { confirmDialog } from './modal.js';

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');

let ctx = null;            // { go, toast, refreshInboxCount }
let selectedId = null;
export function initLeads(c){ ctx = c; }

const relTime = d => {
  if (!d) return '';
  const min = Math.round((Date.now() - new Date(d)) / 60000);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const fmtDate = d => d
  ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  : '';

const folderSvg = `<svg viewBox="0 0 24 24" class="tg-ic"><path d="M3 7a2 2 0 012-2h5l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>`;

const fmtFollowers = n => n == null ? null
  : n >= 1000 ? (n/1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/,'') + 'k followers'
  : n + ' followers';

/* compact one-liner from the enriched profile, or null if nothing was enriched */
function profileLine(l){
  const bits = [l.jobTitle, l.company, l.industry, l.location, fmtFollowers(l.followers)].filter(Boolean);
  return bits.length ? bits.join(' · ') : null;
}

/* ══════════════ PAGE ══════════════ */
// Paint instantly from cache, then revalidate in the background so switching
// tabs never blocks on the network.
export function renderInbox(){ paintPage('inbox'); revalidate('inbox'); }
export function renderLeads(){ paintPage('leads'); revalidate('leads'); }

async function revalidate(view){
  const before = viewSig(view);
  await Promise.all([loadLeads(), loadOffers()]);
  ctx.syncInboxCount?.();
  // repaint only if: still on this tab, no panel open, and the data changed
  if ($('#main')?.dataset.view === view && selectedId === null && viewSig(view) !== before) paintPage(view);
}
function viewSig(view){
  const l = view === 'inbox' ? inbox() : contactedLeads();
  return l.length + '|' + l.map(x => x.id + ':' + x.score).join(',');
}

function paintPage(view){
  const leads = view === 'inbox' ? inbox() : contactedLeads();
  const title = view === 'inbox' ? 'Your <em>inbox</em>' : 'All <em>leads</em>';
  const sub = view === 'inbox'
    ? 'Recommended leads from the last 3 days, best first.'
    : `Leads you have marked contacted, most recent first${
        leads.filter(l=>l.rating).length ? ` · ${leads.filter(l=>l.rating).length} rated` : ''}.`;
  selectedId = null;   // panel opens only when a lead is clicked

  const main = $('#main');
  main.dataset.view = view;
  main.innerHTML = `
    <div class="topbar">
      <h1>${title}</h1>
      <div class="sub">${sub}</div>
      <div class="swash"></div>
    </div>
    <div class="leads-body">
      <div class="leads-list" id="leadsList">
        ${leads.length ? leads.map(l => cardHTML(l, view)).join('')
          : `<div class="empty"><img src="icons/mark.svg" alt="">
              <div class="h">${view==='inbox'?'Nothing new':'Nothing filed yet'}</div>
              <p>${view==='inbox'
                ? 'When analysis surfaces a lead it lands here for three days. Run analysis from an offer to get started.'
                : 'Check a lead in your inbox to mark it contacted, and it is filed here for good.'}</p></div>`}
      </div>
      <aside class="leads-panel" id="leadPanel"></aside>
    </div>`;

  $$('[data-lead]').forEach(el => el.addEventListener('click', () => selectLead(el.dataset.lead)));
  $$('[data-check]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: 'Mark as contacted?',
      body: 'This lead moves to <b>All leads</b> and cannot come back to the inbox.',
      confirm: 'Mark contacted'
    });
    if (!ok) return;
    const id = b.dataset.check;
    if (selectedId === id) closePanel();
    b.closest('.lead-card')?.remove();     // pull the card out of the DOM now
    markContacted(id);                     // flips cache flag synchronously; persists in background
    ctx.syncInboxCount?.();                // count reflects the change immediately
    ctx.toast('Marked contacted — moved to All leads');
    if (!$('#leadsList .lead-card')) paintPage('inbox');   // show empty state if that was the last
  }));
  $$('[data-del]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: 'Delete this lead?',
      body: 'This removes it from the database for good — it cannot be recovered.',
      confirm: 'Delete', danger: true
    });
    if (!ok) return;
    const id = b.dataset.del;
    if (selectedId === id) closePanel();
    b.closest('.lead-card')?.remove();     // instant: gone from the UI now
    deleteLead(id);                        // splices cache synchronously; persists in background
    ctx.syncInboxCount?.();                // both tabs read the same cache, count stays in sync
    ctx.toast('Lead deleted');
    if (!$('#leadsList .lead-card')) paintPage(view);
  }));
}

/* ══════════════ CARD ══════════════ */
function cardHTML(l, view){
  const actions = `<div class="lc-actions">
      ${view==='inbox' ? `<button class="lc-act check" data-check="${l.id}"
        title="Mark contacted — move to All leads">
        <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg></button>` : ''}
      <button class="lc-act del" data-del="${l.id}" title="Delete permanently">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m2 0v14a1 1 0 01-1 1H6a1 1 0 01-1-1V6"/></svg></button>
    </div>`;

  // All-leads: a slim one-line row — score, name, date, delete.
  if (view === 'leads'){
    return `<div class="lead-card compact${l.id===selectedId?' sel':''}" data-lead="${l.id}">
      <div class="lc-score">${l.score}</div>
      <div class="lc-body">
        <div class="lc-head">
          <span class="lc-name">${esc(l.author || 'Unknown')}</span>
          ${l.rating ? `<span class="verd ${l.rating}">${l.rating==='good'?'✓':'✕'}</span>` : ''}
        </div>
      </div>
      <span class="lc-date">contacted ${fmtDate(l.contactedAt || l.analyzedAt)}</span>
      ${actions}
    </div>`;
  }

  // Inbox: the full card.
  return `<div class="lead-card${l.id===selectedId?' sel':''}" data-lead="${l.id}">
    <div class="lc-score">${l.score}</div>
    <div class="lc-body">
      <div class="lc-head">
        <span class="lc-name">${esc(l.author || 'Unknown')}</span>
        ${l.rating ? `<span class="verd ${l.rating}">${l.rating==='good'?'✓':'✕'}</span>` : ''}
        <span class="lc-date">${fmtDate(l.analyzedAt)}</span>
      </div>
      ${profileLine(l) ? `<div class="lc-profile">${esc(profileLine(l))}</div>` : ''}
      <div class="lc-reason">${esc(l.reason || '')}</div>
      <div class="lc-tags">
        <span class="tag-offer">${folderSvg}${esc(l.offerName || 'Offer')}</span>
        ${l.icpName ? `<span class="tag-icp"><i></i>${esc(l.icpName)}</span>` : ''}
      </div>
    </div>
    ${actions}
  </div>`;
}

function selectLead(id){
  selectedId = id;
  $$('.lead-card').forEach(c => c.classList.toggle('sel', c.dataset.lead === id));
  $('.leads-body')?.classList.add('has-panel');
  const panel = $('#leadPanel');
  if (panel){ panel.innerHTML = panelHTML(leadById(id)); panel.scrollTop = 0; }
  bindPanel();
}

function closePanel(){
  selectedId = null;
  $$('.lead-card').forEach(c => c.classList.remove('sel'));
  $('.leads-body')?.classList.remove('has-panel');
  const panel = $('#leadPanel'); if (panel) panel.innerHTML = '';
}

/* ══════════════ PANEL ══════════════ */
/* verdicts: show the good/not-a-fit/pin controls. They belong to the leads
   views; in an ICP's Results list the score alone decides what reaches the inbox. */
function panelHTML(l, { verdicts = true } = {}){
  if (!l) return '';
  let quote = esc(l.text || '');
  if (l.evidence){
    const re = new RegExp('(' + esc(l.evidence).replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'i');
    quote = quote.replace(re, '<mark>$1</mark>');
  }
  return `
    <div class="panel-head">
      <button class="panel-close" id="panelClose" aria-label="Close">&times;</button>
      <div class="ph-top">
        <div class="panel-score">${l.score}</div>
        <div class="ph-name">
          <div class="nm">${esc(l.author || 'Unknown')}</div>
          <div class="ph-when">analyzed ${relTime(l.analyzedAt)}</div>
        </div>
      </div>
      <div class="panel-tags">
        <span class="tag-offer">${folderSvg}${esc(l.offerName || 'Offer')}</span>
        ${l.icpName ? `<span class="tag-icp"><i></i>${esc(l.icpName)}</span>` : ''}
      </div>
    </div>

    <div class="panel-body">
      <div class="panel-links">
        ${l.postUrl ? `<a class="plink" href="${esc(l.postUrl)}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6M10 14L21 3"/></svg>
          Open post</a>` : ''}
        ${l.profileUrl ? `<a class="plink" href="${esc(l.profileUrl)}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1"/></svg>
          Profile</a>` : ''}
      </div>

      ${profileLine(l) ? `<div class="panel-sec">
        <h4>Profile</h4>
        <div class="profile-grid">
          ${l.jobTitle ? `<div><span class="pk">Role</span><span class="pv">${esc(l.jobTitle)}</span></div>` : ''}
          ${l.company ? `<div><span class="pk">Company</span><span class="pv">${esc(l.company)}</span></div>` : ''}
          ${l.industry ? `<div><span class="pk">Industry</span><span class="pv">${esc(l.industry)}</span></div>` : ''}
          ${l.location ? `<div><span class="pk">Location</span><span class="pv">${esc(l.location)}</span></div>` : ''}
          ${l.followers != null ? `<div><span class="pk">Followers</span><span class="pv">${l.followers.toLocaleString()}</span></div>` : ''}
        </div>
      </div>` : `<div class="panel-sec"><h4>Profile</h4>
        <p class="none">Profile could not be enriched — scored on the post text alone.</p></div>`}

      <div class="panel-sec">
        <h4>Why it scored ${l.score}</h4>
        <p class="panel-reason">${esc(l.reason || '')}</p>
        <div class="panel-fit">ICP fit &middot; <b>${esc(l.icpFit || 'unknown')}</b></div>
      </div>

      ${l.text ? `<div class="panel-sec">
        <h4>The post</h4>
        <div class="panel-quote">&ldquo;${quote}&rdquo;</div>
      </div>` : ''}

      <div class="panel-sec fb-sec">
        <h4>${verdicts ? 'Rate this lead' : 'Score this post'}</h4>
        <p class="fb-mini">${verdicts
          ? 'Tell the agent what you think — it calibrates future scoring to your taste.'
          : `Your score replaces the agent's. Anything at <b>${thresholdFor(l.icpId)}</b> or above
             moves this into your inbox.`}</p>
        ${verdicts ? `<div class="fb-btns">
          <button class="fbb good ${l.rating==='good'?'on':''}" data-fb="good">Good fit</button>
          <button class="fbb bad ${l.rating==='bad'?'on':''}" data-fb="bad">Not a fit</button>
          <button class="fbb gold ${l.golden?'on':''}" data-gold="1" title="Pin as a permanent example">★</button>
        </div>` : ''}
        <label class="fb-label" for="fb-score">What should this score? <span>0&ndash;100</span></label>
        <input type="number" id="fb-score" class="fb-score" min="0" max="100" placeholder="e.g. 75"
          value="${l.userScore ?? ''}">
        <input type="text" id="fb-note" class="fb-note" placeholder="Optional: one line on why"
          value="${esc(l.ratingNote || '')}">
        <button class="btn btn-p w" id="fb-submit">${verdicts ? 'Submit to agent' : 'Save score'}</button>
      </div>
    </div>`;
}

function bindPanel(){
  $('#panelClose')?.addEventListener('click', closePanel);
  bindFeedback($('#leadPanel'), () => selectedId, { verdicts: true }, l => {
    // reflect the verdict badge + updated score on the card without a full re-render
    const card = document.querySelector(`.lead-card[data-lead="${l.id}"]`);
    if (card){
      const scoreEl = card.querySelector('.lc-score');
      if (scoreEl) scoreEl.textContent = l.score;
      const head = card.querySelector('.lc-head');
      head.querySelector('.verd')?.remove();
      if (l.rating){
        const badge = document.createElement('span');
        badge.className = `verd ${l.rating}`;
        badge.textContent = l.rating === 'good' ? '✓' : '✕';
        head.querySelector('.lc-name').after(badge);
      }
    }
    const panel = $('#leadPanel');
    if (panel){ panel.innerHTML = panelHTML(l, { verdicts: true }); bindPanel(); }
  });
}

/* Shared feedback wiring for both the inline panel and the Results drawer. */
function bindFeedback(root, getId, opts, after){
  if (!root) return;
  const q = sel => root.querySelector(sel);
  root.querySelectorAll('[data-fb]').forEach(b => b.addEventListener('click', () => {
    const wasOn = b.classList.contains('on');
    root.querySelectorAll('[data-fb]').forEach(x => x.classList.remove('on'));
    if (!wasOn) b.classList.add('on');
  }));
  q('[data-gold]')?.addEventListener('click', async e => {
    const btn = e.currentTarget, on = !btn.classList.contains('on');
    btn.classList.toggle('on', on);
    await pinGolden(getId(), on);
    ctx.toast(on ? 'Pinned as a permanent example' : 'Unpinned');
  });
  q('#fb-submit')?.addEventListener('click', async () => {
    const id = getId();
    const rating = q('[data-fb].on')?.dataset.fb || null;
    const scoreRaw = q('#fb-score')?.value.trim();
    const userScore = scoreRaw === '' ? null : Math.max(0, Math.min(100, Math.round(+scoreRaw)));
    const note = q('#fb-note')?.value.trim() || '';
    if (!rating && userScore == null){
      ctx.toast(opts.verdicts ? 'Pick good/not-a-fit or enter a score first' : 'Enter a score first', true);
      return;
    }
    await rateLead(id, rating, note, userScore);
    const l = leadById(id);
    ctx.toast(userScore != null && isRecommended(l)
      ? `Scored ${l.score} — moved to your inbox`
      : 'Saved — the agent will weight this next run');
    ctx.syncInboxCount?.();
    after?.(l);
  });
}

/* Open a lead's detail as a right-hand drawer, from anywhere (used by the ICP
   Results list, which has no inline panel of its own). */
export function openLeadDrawer(id, onChange){
  const l = leadById(id);
  if (!l) return;
  let wrap = document.getElementById('leadDrawer');
  if (!wrap){
    wrap = document.createElement('div');
    wrap.id = 'leadDrawer';
    document.body.appendChild(wrap);
  }
  const paint = lead => {
    wrap.className = 'drawer-wrap open';
    wrap.innerHTML = `<div class="drawer-bd"></div>
      <aside class="leads-panel drawer-panel">${panelHTML(lead, { verdicts: false })}</aside>`;
    wrap.querySelector('.drawer-bd').addEventListener('click', closeLeadDrawer);
    wrap.querySelector('#panelClose')?.addEventListener('click', closeLeadDrawer);
    bindFeedback(wrap, () => id, { verdicts: false }, updated => { paint(updated); onChange?.(updated); });
  };
  paint(l);
}
export function closeLeadDrawer(){
  const wrap = document.getElementById('leadDrawer');
  if (wrap){ wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 160); }
}
