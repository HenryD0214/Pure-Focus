/* Pure Focus Blocker — content script on the local Pure Focus web app (v2-guard §5.3.4).
   Relays {pf:'app', v:1} window messages to the service worker and {pf:'ext', v:1} replies back.
   Trusts only messages from this window and this origin; caps lists and strings. */
(() => {
  'use strict';
  const port = Number(location.port);
  if (port >= 47615 && port <= 47619) return;          // the Mac app's block page, not the web app
  const VERSION = chrome.runtime.getManifest().version;
  try { document.documentElement.dataset.pfBlocker = VERSION; } catch (_) {}
  const toPage = (msg) => { try { window.postMessage(Object.assign({ pf: 'ext', v: 1 }, msg), location.origin); } catch (_) {} };
  const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : null);
  function clean(d) {
    const out = { type: d.type, origin: location.origin };
    if (d.type === 'focus') {
      out.runID = str(d.runID, 80);
      out.endsAt = str(d.endsAt, 40);
      out.passes = Math.max(0, Math.min(5, Number(d.passes) || 0));
      out.list = (Array.isArray(d.list) ? d.list : []).slice(0, 500)
        .filter((e) => e && (e.kind === 'domain' || e.kind === 'url') && typeof e.value === 'string')
        .map((e) => ({ kind: e.kind, value: e.value.slice(0, 253) }));
      const t = d.theme && typeof d.theme === 'object' ? d.theme : {};
      const col = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$|^rgb/i.test(c.trim()) ? c.trim().slice(0, 40) : null);
      out.theme = { accent: col(t.accent), focus: col(t.focus) };
    } else if (d.type === 'stop') {
      out.runID = str(d.runID, 80);
    }
    return out;
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.pf !== 'app' || d.v !== 1 || !['hello', 'focus', 'stop'].includes(d.type)) return;
    if (d.type === 'hello') toPage({ type: 'hello', version: VERSION });
    try { chrome.runtime.sendMessage({ from: 'bridge', msg: clean(d) }).then((r) => { if (r && r.type) toPage(r); }).catch(() => {}); } catch (_) {}
  });
  chrome.runtime.onMessage.addListener((m) => { if (m && m.to === 'app' && m.msg && m.msg.type) toPage(m.msg); });
  toPage({ type: 'hello', version: VERSION });
})();
