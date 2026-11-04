# Pure Focus — web

A browser version of the Pure Focus macOS app: a Pomodoro timer with a
today's-tasks list, a calendar, background scenes, a rewards layer (XP,
streaks, quests), focus reports and a bundled sound library. No build step
and no framework; the Supabase SDK is fetched from a CDN only when accounts
and sync start.

The site has two pages:

| Page | What it is |
|---|---|
| `index.html` | The marketing homepage (`home.css`, `home.js`): hero, live timer demo, features, FAQ. Every call to action links to the app. Legacy links such as `index.html#reports` are forwarded to `app.html#reports`. |
| `app.html` | The app itself. `app.html#calendar`, `#reports`, `#settings` open that tab directly. |

## Running it

The site is plain static files, but it must be **served over HTTP** rather
than opened as a `file://` URL, because the music and scene catalogues are
fetched with `fetch()` and browsers block that on `file://`.

```sh
cd ~/PureFocus/Web/Site
python3 -m http.server 8765
```

Then open <http://127.0.0.1:8765/> for the homepage, or
<http://127.0.0.1:8765/app.html> for the app. (Use port 8765 for local
development: it is in the Supabase redirect allow-list and in the Google
Calendar/Tasks OAuth client.)

Any static server works — `npx serve`, `php -S`, nginx. There is nothing to
compile. CSS and JS links carry a `?v=N` query; bump it in both pages when
you ship changed files so browsers don't serve stale copies.

## Layout

```
index.html        the marketing homepage
home.css/home.js  homepage styles and behaviour
app.html          the app shell: top bar, four views, task sheet, toast stack
styles.css        tokens, the glass/aurora visual language, core components
css/
  scenes.css      background scenes + the Ambience popover
  rewards.css     the HUD pill, Journey, celebrations
  calendar.css    the Calendar tab
  account.css     the account button, popovers and Settings card
  auth-gate.css   the required sign-in dialog
js/
  store.js        data model + localStorage persistence; the only source of truth
  audio.js        alarms, ticking, ambience, the music library
  charts.js       hand-rolled SVG chart primitives (columns, hbars, line, table)
  tasks.js        the today's-tasks list, the edit sheet, drag reordering
  timer.js        the Pomodoro engine, the ring, the rating prompt
  reports.js      the statistics behind the Reports view
  settings.js     durations, sounds, music, themes, rewards prefs, CSV import/export
  config.js       site configuration (the Google OAuth client ID)
  ics.js          ICS: a dependency-free .ics (iCalendar) parser
  scenes.js       Scenes: background video loops + the Ambience popover
  rewards.js      PFEngagement (the scoring engine) + Rewards (HUD, Journey, celebrations)
  google.js       GoogleSync: Google Calendar and Tasks import (separate from account sign-in)
  calendar.js     CalendarView: day / week / month / agenda over time blocks
  cloudref.js     shared cloud helpers (no UI)
  cloud.js        Cloud: Supabase (or Firebase) auth and sync engine
  cloud-ui.js     CloudUI: the Account card, Sync sheet and setup guidance
  auth-gate.js    AuthGate: the required sign-in dialog
  app.js          bootstrap, view switching, toasts, global mute
backend/
  supabase.sql    the tables, RPCs and RLS policies the cloud engine expects
assets/
  sounds/         13 generated WAVs (6 alarms, 6 ambiences, 1 tick)
  music/          52 tracks in 9 genres, music.json (the catalogue), CREDITS.txt
  scenes/         scenes.json — the scene catalogue (videos stream from Mixkit)
```

Scripts load in dependency order: `store → audio → charts → tasks → timer →
reports → settings → config → ics → scenes → rewards → google → calendar →
cloudref → cloud → cloud-ui → auth-gate → app`. Each is an IIFE that
publishes one global; `app.js` calls every module's `init()` (the gate calls
`Cloud.init()` first so it can decide whether to show the app).

**The top bar** has three calm zones: the brand on the left (just the mark
below 1200 px), the four tabs as one segmented control in the centre, and at
most three controls on the right — the rewards HUD pill (level badge, streak
flame, daily-goal ring; details in its tooltip), the **Ambience** button, and
the account avatar. While a focus session runs, the right-hand controls fade
to 35 % and come back on hover or keyboard focus. On phones the tabs drop to a
full-width strip under the brand row.

**Focus view layout.** The timer is the hero: a centred card capped at 480 px
so the ring keeps its proportions at any window width, with the task list
below it, capped at 980 px. The ring and its time scale fluidly with
`clamp()`. On narrow screens the column simply fills the width; the task
title row wraps its badges rather than clipping. Cards in every two-column
row elsewhere share the tallest sibling's height, so no row is left ragged.

## Features

**Calendar** (`calendar.js`). Day, Week, Month and Agenda views (Day and
Agenda on phones). Draw, drag and resize time blocks, link them to tasks and
start a focus session from a block; unscheduled tasks sit in a tray and can
be dropped onto the grid or auto-planned into today's free time. Import
read-only events from `.ics` files or from Google Calendar; each source can
be removed from Settings › Calendar. Re-importing replaces a source's events
rather than duplicating them.

**Calendar links.** Google, iCloud and Outlook don't send CORS headers, so the
browser can't fetch an `.ics` link directly. Signed-in users fetch links through
the `calendar-proxy` Supabase Edge Function in
`backend/functions/calendar-proxy/index.ts`. Deploy it once to the project with
`supabase functions deploy calendar-proxy --remote=<project-ref> --use-api
--no-verify-jwt`; until then, the Add calendar sheet offers `.ics` import.

**Scenes and the Ambience popover** (`scenes.js`). One top-bar button opens
everything you see and hear behind the timer: a grid of cinematic video
loops (or the animated Aurora), the global sound switch (also `M`), music and
ambience volumes, and the scene's quality and dim. A video scene forces the
dark appearance while it is up, plays on Focus and holds a blurred still on
the other tabs. The same controls live in Settings › Background scene.

**Rewards** (`rewards.js`). XP, levels and tiers, a daily-goal ring, a
streak with earned rest days, a combo for well-spaced sessions, three daily
quests and 26 achievements. Everything is *derived* from the session and
task history by `PFEngagement` — a verbatim copy of the spec's reference
engine — so it applies retroactively and matches the macOS app number for
number. Each session records the daily goal in force when it was logged
(`goalMinutes`), so changing the goal never rescores past days. Every streak
on screen (HUD, Journey, Reports) comes from this engine. Settings › Rewards
chooses the layer (**Full**, **Calm**: streak and goal only, or **Off**) and
the celebrations (**Full**, **Subtle** or **Off**).

**Google** (`google.js`). Optional read-only import of Google Calendar
events (last 7 to next 60 days) and open Google Tasks (de-duplicated across
imports). Disconnecting removes the imported Google events. Nothing changes
until a client ID is configured — see *Google Calendar and Tasks setup*
below; until then Settings › Calendar & Accounts explains the setup and
`.ics` import still works.

## How it works

**Storage.** Everything lives in `localStorage` under the key `purefocus.v1`,
written on a 120 ms debounce. A running timer is mirrored to `purefocus.running`
so a session survives a tab close, and the mute state to `purefocus.sound`.
The new modules keep their own keys: `purefocus.calendar.v1` (blocks and
imported events) and `purefocus.calendar.prefs`, `purefocus.scene`,
`purefocus.ack` (which rewards have been celebrated) and `purefocus.google.*`.
Older data loads unchanged; volume and aurora values saved as 0–100 by
earlier builds are read back as fractions. There is no server and nothing is
uploaded, except the read-only Google requests you start yourself.

**The timer.** `remaining` is derived from a wall-clock deadline (`endAt`)
rather than counted down tick by tick, so the timer stays accurate if the tab
is throttled in the background. `requestAnimationFrame` drives the repaint;
the clock only rewrites the DOM when the displayed second changes.

**The data model matches the macOS app.** Theme presets, alarm sounds, ambience
sounds, categories, and the session record shape are all taken from the app's
`PureFocusCore` models. A session stores raw ids — `ambience: "brown"`,
`alarm: "bowl"`, `music: "Lofi"` — exactly as the app writes them, so an
exported CSV from either program reads the same. Labels are resolved for
display at render time; the raw values stay intact in the file.

**CSV.** Export uses the app's own column order:

```
record,id,title,estimate,completed,is_done,created_at,location,category,scheduled_minutes,actual_minutes,mode,start,end,rating,ambience,alarm,task_id,task_title,music,goal_minutes,due_date,focus_ratio,idle_sec,distract_sec,switch_count,factors,skipped,estimate_set,event_minutes,completed_at,notes,subtasks
```

`record` is `task` or `session`. Import accepts the same format and merges
into the existing data rather than replacing it.

**Charts.** No charting library. `charts.js` builds SVG by hand so the marks
follow one spec: bars capped at 24px with 4px rounded data-ends and square
baselines, 2px lines, markers at least 8px with a 2px surface ring, hairline
gridlines, a value label only on the extreme or the endpoint (never on every
mark), a hover tooltip on every chart, and a table view twin for every chart.

Single-measure charts use one hue for every bar — a colour ramp across
nominal categories would encode bar length twice. The categorical palette
(`--series-1` … `--series-8`) is the validated reference palette, stepped
separately for the dark and light surfaces rather than flipped.

**Themes.** Six presets, identical to the app's `ThemePreset.all`: Ember,
Ocean, Forest, Lavender, Rose, Graphite. Each supplies an accent plus a
focus, short-break and long-break tint. The light and dark schemes have their
own chart palette, their own surfaces, and their own text tokens.

## Keyboard

| Key | Action |
|---|---|
| `Space` | start / pause the timer (Focus and Reports tabs; ignored while typing, on a focused control, or under an open dialog) |
| `M` | mute / unmute all sound (not on the Calendar tab, where `M` is Month) |
| `⌘↩` | save the open task editor |
| `Esc` | close the task editor or an open popover |
| `T` `D` `W` `M` `A` `N` `←` `→` | Calendar tab: today, day, week, month, agenda, new block, previous / next |

## Sound library

The 13 WAVs in `assets/sounds/` are synthesised by
`~/PureFocus/Scripts/generate_sounds.swift` — no samples were downloaded.
The 52 music tracks in `assets/music/` are listed in `music.json` with their
licence, source and loudness measurements, and credited in `CREDITS.txt`.
They are AAC (`.m4a`) to stay inside the library's 250 MB budget.

Browser autoplay rules apply: sound only starts after the first click or
keystroke on the page.

### Music player

Music plays as a full transport, not a fire-and-forget loop:

- The **now-playing bar** on the Focus view shows the track, artist and
  genre, an animated equaliser in the artwork, play / pause, previous /
  next, elapsed and total time, and a draggable seek bar (arrow keys nudge
  ±5 s, Shift for ±30 s). Previous restarts the current track if more than
  three seconds have played.
- The **Settings › Now playing** card mirrors it with a simple live player
  and the shared music-volume slider.
- The **Music library** card lists every genre and track with a search box
  (matches title or artist), a track count, a looping-indicator dot on the
  selected genre, and a Shuffle toggle that picks a random track when a
  genre is chosen.
- Picking a genre (or a track) writes the genre into `selectedMusic`, so a
  logged session records the genre exactly as the macOS app does, and the
  genre shows up in the Reports › Insights genre-rating chart.

## Accounts and sync (Supabase)

Pure Focus requires an account. Sign-in and sync use the Supabase project in
`js/config.js` (`Config.CLOUD`): Google or email/password, with tasks,
sessions and settings stored in `pf_records` and protected by row-level
security. The publishable key is meant to ship in the browser; the RLS
policies and RPCs in `backend/supabase.sql` are what protect the data.

One-time setup:

1. In the Supabase dashboard, open **SQL Editor** and run
   `backend/supabase.sql` once. It creates `pf_records`, `pf_profiles`, the
   RPCs and the RLS policies the app expects. Without this step the app still
   signs in, but sync reports "setup needed" in Settings › Calendar & Accounts.
2. Under **Authentication › URL Configuration**, set the **Site URL** to the
   production origin and add these **Redirect URLs**:
   - `http://localhost:8765/**`
   - `http://127.0.0.1:8765/**`
   - your production origin, for example `https://your-domain.example/**`
3. Under **Authentication › Providers**, enable **Google** and **Email**. For
   Google, paste the OAuth client ID and secret from the Google Cloud console
   and add the Supabase callback URL
   (`https://<project-ref>.supabase.co/auth/v1/callback`) to the client's
   authorised redirect URIs.
4. Email confirmation is on in this project, so confirmation and password
   reset emails link back to the Site URL. Set it before inviting anyone.

`js/auth-gate.js` keeps the app hidden and inert until a session exists, and
re-locks it after `Cloud.signOut()`. The account card in Settings handles the
signed-in state, sync preferences and the one-time setup guidance.

## Google Calendar and Tasks setup

Google Calendar and Tasks import stays off until a Web OAuth client ID is
pasted into `js/config.js`. This is separate from account sign-in: the gate
uses Supabase's Google provider, while this client only grants read-only
access to calendars and tasks. One-time setup, in the Google Cloud project
**pure-focus-512121**:

1. Open **APIs & Services › Library** and enable the **Google Calendar API**
   and the **Google Tasks API**.
2. Open **APIs & Services › OAuth consent screen**. Keep the app in
   *Testing*, and under **Test users** add every Google account that should be
   able to sign in (start with your own).
3. Open **APIs & Services › Credentials › Create credentials › OAuth client
   ID**, choose application type **Web application**, and add these
   **Authorised JavaScript origins**:
   - `http://localhost:8765`
   - `http://127.0.0.1:8765`

   No redirect URI and no client secret are needed (the site uses Google
   Identity Services' token flow in the browser).
4. Copy the client ID (`….apps.googleusercontent.com`) into `js/config.js`:

   ```js
   const Config = Object.freeze({
     GOOGLE_WEB_CLIENT_ID: '1234567890-abc….apps.googleusercontent.com',
   });
   ```

5. Serve the site on port 8765 (see *Running it*) and reload. Settings ›
   Calendar & Accounts now offers **Connect Google Calendar & Tasks**.

The app asks only for read-only scopes (`calendar.readonly`,
`tasks.readonly`). To serve from another origin, add that origin to the
client as well.

## Verifying changes

The `~/PureFocus/Web/Tools/` directory holds the harness used while building
this: a WebKit screenshot script (`shot.py`), a data seeder (`seed.js`), and a
functional self-test (`selftest.js`) that drives the timer, tasks, reports,
themes, CSV round-trip, music library and the integration hooks (goal
snapshot, rewards settings, streak agreement, the Space and mute keys,
volume storage, calendar import de-duplication, the three-control top bar)
and reports pass/fail counts.

```sh
cd ~/PureFocus/Web/Tools
python3 -m http.server 8765 --directory ~/PureFocus/Web/Site &   # if not running

# a screenshot (the 6th argument is injected at document start, e.g. seed.js)
python3 -I shot.py "http://127.0.0.1:8765/app.html" /tmp/out.png 1440 900 5 "$(cat seed.js)"

# the self-test: run it once the app has started, then read the result back
python3 -I shot.py "http://127.0.0.1:8765/app.html" /tmp/out.png 1440 900 7 \
  "document.addEventListener('DOMContentLoaded',function(){setTimeout(function(){window.__st=$(cat selftest.js)},2500);});" \
  "String(window.__st)"
```

`shot.py` prints any uncaught page error (`PAGE ERROR`) and evaluates its 7th
argument in the page (`EVAL`), which is how the self-test reports back. Its
6th argument runs at *document start*, before the app's scripts, so the
self-test must be deferred as above. WKWebView caches aggressively: if a
screenshot shows stale files, delete
`~/Library/Caches/org.python.python/WebKit/NetworkCache` and shoot again.
