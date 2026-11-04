/* Pure Focus Blocker — the friendly block page (v2-guard §5.3.5). Opened by the extension with
   #<json {d: domain, u: original URL, k: key}>; reopens the original page when the session ends. */
(() => {
  'use strict';
  let info = {};
  try { info = JSON.parse(decodeURIComponent(location.hash.slice(1))) || {}; } catch (_) { info = {}; }
  const d = typeof info.d === 'string' ? info.d.slice(0, 253) : 'This site';
  const u = typeof info.u === 'string' && /^https?:\/\//i.test(info.u) ? info.u : null;
  const $ = (id) => document.getElementById(id);
  const CIRC = 2 * Math.PI * 54;
  let endsAt = null, startedAt = Date.now(), lastMinute = null, done = false;
  document.title = d + ' can wait';
  $('title').textContent = d + ' can wait';

  const send = (msg) => chrome.runtime.sendMessage(Object.assign({ from: 'blocked' }, msg));
  const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function restore(text) {
    if (done) return;
    done = true;
    $('title').textContent = text;
    $('body').textContent = u ? 'Opening ' + d + '…' : '';
    setTimeout(() => { if (u) location.replace(u); }, 1200);
  }
  async function refresh() {
    let st = null;
    try { st = await send({ type: 'info' }); } catch (_) { st = null; }
    if (!st) return;
    if (st.theme && st.theme.accent) document.documentElement.style.setProperty('--accent', st.theme.accent);
    if (st.theme && st.theme.focus) document.documentElement.style.setProperty('--focus', st.theme.focus);
    if (!st.active) { restore('Session done'); return; }
    endsAt = Date.parse(st.endsAt);
    $('body').textContent = "You're in a focus session until " + fmtClock(endsAt) + '.' + (st.macOnly ? ' Pause in Pure Focus to open it now.' : '');
    const left = st.passesLeft || 0;
    $('passWrap').hidden = left <= 0;
    $('noPass').hidden = left > 0;
    $('passCap').textContent = left + (left === 1 ? ' pass' : ' passes') + ' left this session · press and hold';
  }
  function tick() {
    if (!endsAt || done) return;
    const rem = Math.max(0, endsAt - Date.now());
    const m = Math.floor(rem / 60000), s = Math.floor((rem % 60000) / 1000);
    $('time').textContent = m + ':' + String(s).padStart(2, '0');
    const total = Math.max(1, endsAt - startedAt);
    $('arc').style.strokeDashoffset = String(CIRC * (1 - Math.min(1, rem / total)));
    if (m !== lastMinute) { lastMinute = m; $('live').textContent = m + ' minutes left in this focus session'; }
    if (rem <= 0) refresh();
  }

  $('back').addEventListener('click', () => {
    if (history.length > 1) history.back();
    else send({ type: 'close' });
  });

  // press-and-hold 1.2 s (pointer, Space or Enter); releasing early cancels
  const HOLD = 1200, RING = 2 * Math.PI * 9;
  let holdStart = null, raf = null;
  const fill = $('holdFill');
  function step() {
    if (holdStart == null) return;
    const p = Math.min(1, (performance.now() - holdStart) / HOLD);
    fill.style.strokeDashoffset = String(RING * (1 - p));
    if (p >= 1) { holdStart = null; spend(); return; }
    raf = requestAnimationFrame(step);
  }
  function begin(e) { if (e) e.preventDefault(); if (holdStart != null) return; holdStart = performance.now(); raf = requestAnimationFrame(step); }
  function cancel() { holdStart = null; cancelAnimationFrame(raf); fill.style.strokeDashoffset = String(RING); }
  async function spend() {
    const r = await send({ type: 'pass', d }).catch(() => null);
    if (r && r.ok && u) location.replace(u);
    else refresh();
  }
  const hold = $('hold');
  hold.addEventListener('pointerdown', begin);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => hold.addEventListener(t, cancel));
  hold.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) begin(e); });
  hold.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') cancel(); });
  hold.addEventListener('click', (e) => e.preventDefault());

  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.pf) refresh(); });
  refresh();
  setInterval(tick, 1000);
  setInterval(refresh, 30000);
})();
