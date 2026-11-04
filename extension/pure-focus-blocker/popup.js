/* Pure Focus Blocker — popup (v2-guard §5.3.6). Read-only: the list is owned by the apps. */
(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const st = await chrome.runtime.sendMessage({ from: 'popup', type: 'poll' }).catch(() => null);
  if (!st) { $('status').textContent = 'Not available right now'; return; }
  if (st.active) {
    const min = Math.max(0, Math.round((Date.parse(st.endsAt) - Date.now()) / 60000));
    $('status').textContent = 'Focusing · ' + min + ' min left';
    $('sub').textContent = 'Listed sites are blocked until the session ends.';
    $('arc').setAttribute('stroke-dasharray', (69.1 * Math.min(1, min / 25)).toFixed(1) + ' 69.1');
  } else {
    $('status').textContent = 'Not focusing';
    $('sub').textContent = 'Sites open normally.';
  }
  $('mac').textContent = st.mac && st.mac.found ? 'Connected ✓' : 'Not found';
  $('web').textContent = st.web && st.web.origin ? 'Connected ✓ (' + st.web.origin.replace(/^https?:\/\//, '') + ')' : 'Open Pure Focus to connect';
  $('passes').textContent = st.active ? String(st.passesLeft) : '—';
  const chips = $('chips');
  const list = st.entries || [];
  if (!list.length) chips.hidden = true;
  list.slice(0, 12).forEach((e) => { const c = document.createElement('span'); c.className = 'chip'; c.textContent = e.value; chips.appendChild(c); });
  if (list.length > 12) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = '+ ' + (list.length - 12) + ' more'; chips.appendChild(c); }
  $('edit').addEventListener('click', (e) => {
    e.preventDefault();
    const origin = (st.web && st.web.origin) || 'http://127.0.0.1:8765';
    chrome.tabs.create({ url: origin + '/app.html#settings' });
  });
  // "Connect this site" (hosted Pure Focus only; P2): the page must declare <meta name="pure-focus-app" content="1">.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https:\/\//.test(tab.url)) {
      const origin = new URL(tab.url).origin;
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => !!document.querySelector('meta[name="pure-focus-app"][content="1"]') }).catch(() => [null]);
      if (res && res.result) {
        const b = $('connect');
        b.hidden = false;
        b.addEventListener('click', async () => {
          const ok = await chrome.permissions.request({ origins: [origin + '/*'] });
          if (!ok) return;
          await chrome.scripting.registerContentScripts([{ id: 'bridge-' + new URL(origin).host, matches: [origin + '/*'], js: ['bridge.js'], runAt: 'document_start' }]).catch(() => {});
          b.textContent = 'Connected ✓ — reload the Pure Focus tab';
          b.disabled = true;
        });
      }
    }
  } catch (_) {}
})();
