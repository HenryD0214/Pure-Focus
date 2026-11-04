/* ═══════════════════════════════════════════════════════════════════════
   shell.js — the app frame: the sidebar and the Focus page's tasks panel

   · Sidebar (#sidebar): sections, today's goal, Settings and the account. Its toggle folds it away
     (html.sb-collapsed, remembered); #sb-open brings it back. At phone width it is a drawer
     instead (html.sb-drawer-open, never remembered) that closes when you pick a section.
   · Today's Tasks (#tasks-panel): the panel's own toggle folds it away (html.tasks-collapsed,
     remembered); the corner button (#tasks-open, with the open count) brings it back.
   · html[data-view] names the section on show, so css/shell.css can lay out each one.
   css/shell.css does all the moving; this only flips classes.

   Public API: Shell.onView(name) (App.showView calls it), Shell.toggleSidebar(), Shell.toggleTasks()
   ═══════════════════════════════════════════════════════════════════════ */

const Shell = (() => {
  'use strict';

  const K_SIDEBAR = 'purefocus.ui.sidebar';
  const K_TASKS = 'purefocus.ui.tasksPanel';
  const DRAWER_MQ = '(max-width: 760px)';
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);

  function read(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode: not remembered */ } }

  let mq = null;
  const isDrawer = () => !!(mq && mq.matches);
  // The Calendar opens as a full-width workspace: the sidebar folds away on the way in
  // and comes back on the way out, without overwriting the remembered preference.
  let autoCollapsed = false;

  // The page width changes under the calendar and charts when a panel folds: let them re-measure
  // once the slide has finished.
  let settleTimer = 0;
  function settle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => window.dispatchEvent(new Event('resize')), 340);
  }

  // ── sidebar ──
  function syncSidebar() {
    const open = isDrawer() ? root.classList.contains('sb-drawer-open') : !root.classList.contains('sb-collapsed');
    const collapse = $('sb-collapse'), reopen = $('sb-open');
    if (collapse) collapse.setAttribute('aria-expanded', String(open));
    if (reopen) reopen.setAttribute('aria-expanded', String(open));
    const side = $('sidebar');
    // a folded or closed sidebar is out of the tab order
    if (side) side.inert = !open;
  }
  function setSidebar(open) {
    if (isDrawer()) {
      root.classList.toggle('sb-drawer-open', open);
    } else {
      root.classList.toggle('sb-collapsed', !open);
      write(K_SIDEBAR, open ? 'open' : 'collapsed');
      autoCollapsed = false;
      settle();
    }
    syncSidebar();
  }
  // Focus follows the toggle for keyboard use (a click from a key press has detail 0), and
  // whenever it would otherwise be left inside the part that just went away.
  // (Checked before the part goes inert, which drops focus on its own.)
  function focusAfter(e, hiding, target, change) {
    const move = (!!e && e.detail === 0) || (!!hiding && hiding.contains(document.activeElement));
    change();
    if (move && target && target.offsetParent) target.focus({ preventScroll: true });
  }
  function toggleSidebar(e) {
    const open = isDrawer() ? root.classList.contains('sb-drawer-open') : !root.classList.contains('sb-collapsed');
    focusAfter(e, open ? $('sidebar') : null, open ? $('sb-open') : $('sb-collapse'), () => setSidebar(!open));
  }

  // ── tasks panel ──
  function setTasks(open, remember) {
    root.classList.toggle('tasks-collapsed', !open);
    if (remember !== false) write(K_TASKS, open ? 'open' : 'collapsed');
    const btn = $('tasks-collapse'), reopen = $('tasks-open'), panel = $('tasks-panel');
    if (btn) btn.setAttribute('aria-expanded', String(open));
    if (reopen) { reopen.hidden = open; reopen.setAttribute('aria-expanded', String(open)); }
    if (panel) panel.inert = !open;
    syncCount();
  }
  function toggleTasks(e) {
    const open = root.classList.contains('tasks-collapsed');
    focusAfter(e, open ? null : $('tasks-panel'), open ? $('tasks-collapse') : $('tasks-open'), () => setTasks(open));
  }
  // the corner button carries the open count while the panel is folded away
  function syncCount() {
    const src = $('open-count'), dst = $('tasks-open-count'), btn = $('tasks-open');
    if (!src || !dst || !btn) return;
    const n = src.hidden ? '' : (src.textContent || '').trim();
    dst.textContent = n;
    dst.hidden = !n || n === '0';
    const label = n && n !== '0' ? `Show Today's Tasks (${n} open)` : "Show Today's Tasks";
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  function onView(name) {
    root.dataset.view = name;
    // Calendar is a full-width workspace: fold the sidebar on the way in and bring it
    // back on the way out, leaving the remembered open/collapsed choice untouched.
    if (!isDrawer()) {
      if (name === 'calendar' && !root.classList.contains('sb-collapsed')) {
        root.classList.add('sb-collapsed');
        autoCollapsed = true;
        syncSidebar();
        settle();
      } else if (name !== 'calendar' && autoCollapsed) {
        root.classList.remove('sb-collapsed');
        autoCollapsed = false;
        syncSidebar();
        settle();
      }
    }
    // Declutter hides the way back, and it only means anything on the Focus page
    if (name !== 'focus' && typeof Declutter !== 'undefined' && Declutter.level()) Declutter.set(0);
    // a popover belongs to the page it opened on (a mouse click closes these already, a keyboard doesn't)
    for (const close of [() => Player.closeCard(), () => Scenes.close(), () => Tasks.closeMenu(), () => Guard.closePopover()]) {
      try { close(); } catch (_) {}
    }
    // light over a dark scene adapts on the Focus page only (Settings.applyTheme)
    try { if (typeof Settings !== 'undefined' && Settings.applyTheme) Settings.applyTheme(); } catch (_) {}
    // picking a section in the drawer closes it
    if (isDrawer() && root.classList.contains('sb-drawer-open')) setSidebar(false);
  }

  function init() {
    if (!root.dataset.view) root.dataset.view = 'focus';
    mq = window.matchMedia ? window.matchMedia(DRAWER_MQ) : null;
    if (read(K_SIDEBAR) === 'collapsed') root.classList.add('sb-collapsed');
    setTasks(read(K_TASKS) !== 'collapsed', false);
    syncSidebar();

    const collapse = $('sb-collapse'), reopen = $('sb-open'), scrim = $('sb-scrim');
    if (collapse) collapse.addEventListener('click', toggleSidebar);
    if (reopen) reopen.addEventListener('click', toggleSidebar);
    if (scrim) scrim.addEventListener('click', () => setSidebar(false));
    const tc = $('tasks-collapse'), to = $('tasks-open');
    if (tc) tc.addEventListener('click', toggleTasks);
    if (to) to.addEventListener('click', toggleTasks);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isDrawer() && root.classList.contains('sb-drawer-open')) {
        e.preventDefault();
        setSidebar(false);
        if (reopen) reopen.focus({ preventScroll: true });
      }
    });
    if (mq) {
      const onMq = () => { root.classList.remove('sb-drawer-open'); syncSidebar(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    }
    const src = $('open-count');
    if (src && 'MutationObserver' in window) {
      new MutationObserver(syncCount).observe(src, { attributes: true, attributeFilter: ['hidden'], childList: true, characterData: true, subtree: true });
    }
    // no slide on first paint
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('shell-ready')));
  }

  init();
  return { onView, toggleSidebar, toggleTasks };
})();
