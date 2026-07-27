/* ==========================================================================
   In-app confirm dialog — a styled modal that replaces window.confirm.
   Returns a Promise<boolean> (true = confirmed). Strings are trusted (no
   user input is interpolated), so they may contain simple markup.
   ========================================================================== */
export function confirmDialog({ title, body, confirm = 'Confirm', cancel = 'Cancel', danger = false } = {}){
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="${title || 'Confirm'}">
        <h3 class="modal-title">${title || 'Are you sure?'}</h3>
        ${body ? `<p class="modal-body">${body}</p>` : ''}
        <div class="modal-actions">
          <button class="modal-btn cancel" data-x>${cancel}</button>
          <button class="modal-btn ${danger ? 'danger' : 'go'}" data-ok>${confirm}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));

    const close = val => {
      wrap.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => wrap.remove(), 160);
      resolve(val);
    };
    const onKey = e => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter')  close(true);
    };
    document.addEventListener('keydown', onKey);
    wrap.querySelector('[data-ok]').addEventListener('click', () => close(true));
    wrap.querySelector('[data-x]').addEventListener('click', () => close(false));
    wrap.addEventListener('click', e => { if (e.target === wrap) close(false); });
    wrap.querySelector('[data-ok]').focus();
  });
}
