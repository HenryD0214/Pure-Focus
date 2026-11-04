/* Premium gate — a single reusable lock for Focus Pro features.
   It only locks once Plan has finished loading, so a premium user never sees a flash. */
const PremiumGate = (() => {
  function isReady() { return typeof Plan !== 'undefined' && !Plan.loading; }
  function isPremium() { return typeof Plan !== 'undefined' && !!Plan.isPremium; }
  function isLocked() { return isReady() && !isPremium(); }

  const LOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.4 10V7.6a3.6 3.6 0 0 1 7.2 0V10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  function openPro() {
    if (typeof ProModal !== 'undefined' && ProModal && ProModal.open) { ProModal.open(); return; }
    // The standalone /pro page was removed; the popup is the only purchase surface.
    console.warn('Focus Pro is unavailable: ProModal did not load.');
  }

  function overlay(opts) {
    const o = opts || {};
    const box = document.createElement('div');
    box.className = 'pf-lock-overlay';
    box.innerHTML =
      '<div class="pf-lock-inner">' +
        '<span class="pf-lock-ic">' + LOCK_SVG + '</span>' +
        '<strong class="pf-lock-title">' + (o.title || 'Focus Pro') + '</strong>' +
        '<span class="pf-lock-desc">' + (o.desc || 'Unlock this feature with Focus Pro.') + '</span>' +
        '<button type="button" class="btn btn-primary btn-sm pf-lock-btn">' + (o.cta || 'Unlock with Focus Pro') + '</button>' +
      '</div>';
    box.querySelector('.pf-lock-btn').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPro(); });
    return box;
  }

  /* Lock a card or panel. Content stays visible underneath (blurred), never deleted. */
  function lock(el, opts) {
    if (!el) return;
    const already = el.querySelector(':scope > .pf-lock-overlay');
    if (!isLocked()) {
      if (already) already.remove();
      el.classList.remove('pf-locked');
      return;
    }
    el.classList.add('pf-locked');
    if (!already) el.appendChild(overlay(opts));
  }

  /* Lock a whole tab pane (Insights, Breakdown). The pane keeps its content; the
     overlay covers it and blocks interaction until the plan is Pro. */
  function lockView(pane, opts) {
    if (!pane) return;
    let ov = pane.querySelector(':scope > .pf-lock-overlay');
    if (!isLocked()) {
      if (ov) ov.remove();
      pane.classList.remove('pf-view-locked');
      return;
    }
    pane.classList.add('pf-view-locked');
    if (!ov) { ov = overlay(opts); ov.classList.add('pf-lock-overlay--view'); pane.appendChild(ov); }
  }

  function refreshAll() {
    document.querySelectorAll('.pf-locked, .pf-view-locked').forEach((el) => {
      if (el.classList.contains('pf-view-locked')) lockView(el, { title: el.dataset.pfTitle || 'Focus Pro', desc: el.dataset.pfDesc || 'Unlock this view with Focus Pro.' });
    });
  }

  // For cards/views that need a visible locked preview + button
  function lockCard(el) { lock(el); }

  return { apply: lock, lock, lockView, lockCard, refreshAll, isReady, isPremium, isLocked, openPro };
})();
