# Pure Focus Blocker

A small browser extension for **Chrome, Edge, Brave, Arc and other Chromium browsers**. While a Pure Focus
focus session is running, it keeps the sites on your Focus Guard list closed and shows a calm "can wait"
page instead. When the session ends (or you pause), those tabs reopen by themselves.

It does nothing outside focus sessions, and it stores nothing about your browsing.

> Safari can't run this extension. In Safari, use the Pure Focus Mac app, which can block sites in Safari.

## Install (about a minute)

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder: `~/PureFocus/Web/Site/extension/pure-focus-blocker`.
4. Open Pure Focus (`http://127.0.0.1:8765/app.html`). Settings › Focus Guard › Browser blocker now says
   **Extension connected ✓**.
5. Turn on **Block listed sites during focus** and add sites to your **Distraction list**.

If you move the folder later, load it again from the new place.

## How it works

- Pure Focus (the web app, through `bridge.js`, or the Mac app, through its local status server) tells the
  extension when a focus session starts and ends, and which sites are on your list.
- The extension adds `declarativeNetRequest` rules for exactly those sites (top-level pages only, so a video
  embedded in Canvas keeps working) and removes **all** of them the moment no session is running.
  If anything goes wrong, it fails open: nothing stays blocked.
- **I really need this · 5 min**: press and hold on the block page to open the site for 5 minutes.
  You get a few of these per session (set in Pure Focus).

## Why it asks for these permissions

| Permission | Why |
|---|---|
| `declarativeNetRequest` | Block and unblock your listed sites without reading page contents. |
| `tabs`, `webNavigation` | See the address of a page you open, to show the friendly page and to reopen tabs afterwards. Chrome calls this "Read your browsing history"; the extension keeps none of it. |
| `alarms` | Notice when a session ends; check the Mac app every 30 seconds. |
| `storage` | Your list, the session clock and per-session counts (blocked visits, passes). |
| `scripting` + optional `https://*/*` | Only if you click "Connect this site" for a hosted copy of Pure Focus. |
| `http://127.0.0.1/*`, `http://localhost/*` | Talk to Pure Focus running on this computer. |

## Files

`manifest.json` · `sw.js` (service worker) · `rules.js` (the shared, tested GuardRules + a module export) ·
`bridge.js` (content script on the local web app) · `blocked.html/.css/.js` · `popup.html/.js` · `icons/`.

Tests: `~/PureFocus/Web/Tools/tests/w4-blocker.test.js` (run `bash tests/run-jsc.sh w4`).
