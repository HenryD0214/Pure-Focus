/* ═══════════════════════════════════════════════════════════════════════
   reports.js — the Reports view
   The same statistics the macOS app computes, over the sessions logged
   in this browser.
   ═══════════════════════════════════════════════════════════════════════ */

const Reports = (() => {
  let period = 'week';       // day | week | month
  let reportTab = 'overview'; // overview | insights | breakdown

  const $ = (sel) => document.querySelector(sel);

  // ── tab registry (SPEC-V2 §4.8; added by W1·A) ──
  // registerTab({id, title, order, render(el, period)}) → unregister. A tab whose id is a
  // built-in pane (overview · insights · breakdown) takes that pane over (its old content is
  // hidden); a new id gets a segment button and a pane. render(el, period) runs whenever the
  // tab is shown and on every Reports.render() while it is active (period: day|week|month).
  const BUILTIN_TABS = { overview: 1, insights: 2, breakdown: 3 };
  const tabs = new Map();   // id → {spec, host}
  let tabsReady = false;

  function paneOf(id) { return document.querySelector(`.report-pane[data-rpane="${id}"]`); }

  function mountTab(id) {
    const t = tabs.get(id);
    const sw = $('#report-tab-switch');
    if (!t || !sw) return;
    let pane = paneOf(id);
    if (!pane) {
      const btn = document.createElement('button');
      btn.className = 'seg-btn';
      btn.setAttribute('role', 'tab');
      btn.dataset.rtab = id;
      btn.dataset.registered = 'true';
      btn.setAttribute('aria-selected', 'false');
      btn.textContent = t.spec.title || id;
      const order = Number.isFinite(t.spec.order) ? t.spec.order : 99;
      const next = Array.from(sw.querySelectorAll('.seg-btn')).find((b) => {
        const o = BUILTIN_TABS[b.dataset.rtab] ?? (tabs.get(b.dataset.rtab) ? (tabs.get(b.dataset.rtab).spec.order ?? 99) : 99);
        return o > order;
      });
      sw.insertBefore(btn, next || null);
      pane = document.createElement('div');
      pane.className = 'report-pane';
      pane.dataset.rpane = id;
      pane.dataset.registered = 'true';
      pane.hidden = reportTab !== id;
      const panes = document.querySelectorAll('.report-pane');
      panes[panes.length - 1].after(pane);
    } else {
      Array.from(pane.children).forEach((n) => { if (n !== t.host) { n.hidden = true; n.dataset.replaced = 'true'; } });
    }
    if (!t.host) {
      t.host = document.createElement('div');
      t.host.className = 'report-tab-host';
      t.host.dataset.tab = id;
    }
    pane.appendChild(t.host);
    if (reportTab === id) renderTab(id);
  }

  function renderTab(id) {
    const t = tabs.get(id);
    if (!t || !t.host || typeof t.spec.render !== 'function') return;
    try { t.spec.render(t.host, period); } catch (err) { console.error(`Reports: tab "${id}" failed to render`, err); }
  }

  function registerTab(spec) {
    if (!spec || typeof spec.id !== 'string' || !spec.id) return () => {};
    const prev = tabs.get(spec.id);
    if (prev && prev.host) prev.host.remove();
    const entry = { spec, host: null };
    tabs.set(spec.id, entry);
    if (tabsReady) mountTab(spec.id);
    return () => {
      if (tabs.get(spec.id) !== entry) return;
      tabs.delete(spec.id);
      if (entry.host) entry.host.remove();
      const pane = paneOf(spec.id);
      if (pane && pane.dataset.registered) {
        pane.remove();
        const btn = document.querySelector(`#report-tab-switch .seg-btn[data-rtab="${spec.id}"]`);
        if (btn) btn.remove();
      } else if (pane) {
        Array.from(pane.children).forEach((n) => { if (n.dataset.replaced) { n.hidden = false; delete n.dataset.replaced; } });
      }
    };
  }

  // ── statistics ──

  function range() {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (period === 'week') start.setDate(start.getDate() - 6);
    if (period === 'month') start.setDate(start.getDate() - 29);
    return { start, end: now };
  }

  // Focus sessions in the period. A "session" under half a minute is a Skip pressed before any
  // focus (recorded by older versions) — not a session.
  function focusSessions() {
    const { start, end } = range();
    return Store.sessions().filter((s) => s.mode === 'focus' && Number(s.minutes) >= 0.5 && new Date(s.start) >= start && new Date(s.start) <= end);
  }
  // finished = ran its whole length; cut short = ended early with Skip
  function finished(s) {
    const sched = Number(s.scheduledMinutes);
    return !s.skipped && (!(sched > 0) || Number(s.minutes) >= sched * 0.9);
  }
  // time of day · place · music · type of work (Insights owns the grouping, so both pages agree)
  function groupBy(dim, list) {
    if (typeof Insights !== 'undefined' && Insights.dimensions) return Insights.dimensions(list, dim);
    const m = new Map();
    for (const x of list) { const k = x.category || null; const g = m.get(k) || { key: k, label: k || 'No type set', n: 0, minutes: 0, rated: 0, avg: null, finished: 0 }; g.n++; g.minutes += x.minutes; m.set(k, g); }
    return [...m.values()];
  }

  function sessionsInRange() {
    const { start, end } = range();
    return Store.sessions().filter((s) => new Date(s.start) >= start && new Date(s.start) <= end);
  }

  function totalFocusMinutes() {
    return focusSessions().reduce((sum, s) => sum + s.minutes, 0);
  }

  function totalPomodoros() { return focusSessions().length; }

  function breakMinutes() {
    return sessionsInRange().filter((s) => s.mode !== 'focus').reduce((sum, s) => sum + s.minutes, 0);
  }

  function averageRating() {
    const ratings = focusSessions().map((s) => s.focusRating).filter((r) => r != null);
    if (!ratings.length) return null;
    return ratings.reduce((a, b) => a + b, 0) / ratings.length;
  }

  /* The streak everyone shows. The rewards engine owns it when it is loaded
     (its streak honours earned rest days), so the Reports cards, the HUD
     flame and the Journey always agree; the plain calendar count below is
     only the fallback for a page without js/rewards.js. */
  function currentStreak() {
    try {
      if (typeof Rewards !== 'undefined' && Rewards && typeof Rewards.state === 'function') {
        const st = Rewards.state();
        if (st && st.streak && Number.isFinite(st.streak.current)) return st.streak.current;
      }
    } catch (_) { /* fall back to the calendar count */ }
    return calendarStreak();
  }

  function calendarStreak() {
    const days = new Set();
    for (const s of Store.sessions()) {
      if (s.mode !== 'focus') continue;
      const d = new Date(s.start);
      d.setHours(0, 0, 0, 0);
      days.add(d.getTime());
    }
    let streak = 0;
    let cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    if (!days.has(cursor.getTime())) cursor.setDate(cursor.getDate() - 1);
    while (days.has(cursor.getTime())) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function dailyStats() {
    const { start, end } = range();
    const sessions = focusSessions();

    if (period === 'day') {
      const hours = [];
      const dayStart = new Date(start);
      for (let h = 0; h < 24; h++) {
        const hStart = new Date(dayStart);
        hStart.setHours(h, 0, 0, 0);
        const hNext = new Date(hStart);
        hNext.setHours(h + 1);
        const inHour = sessions.filter((s) => {
          const t = new Date(s.start);
          return t >= hStart && t < hNext && t <= end;
        });
        hours.push({
          date: hStart,
          minutes: inHour.reduce((sum, s) => sum + s.minutes, 0),
          pomodoros: inHour.length,
        });
      }
      return hours;
    }

    const days = [];
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    while (cursor <= end) {
      const next = new Date(cursor);
      next.setDate(next.getDate() + 1);
      const inDay = sessions.filter((s) => {
        const t = new Date(s.start);
        return t >= cursor && t < next;
      });
      days.push({
        date: new Date(cursor),
        minutes: inDay.reduce((sum, s) => sum + s.minutes, 0),
        pomodoros: inDay.length,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }

  function taskBreakdown() {
    const grouped = new Map();
    for (const s of focusSessions()) {
      if (!s.taskTitle) continue;          // focus without a task isn't a "top task"
      const key = s.taskTitle;
      const cur = grouped.get(key) || { minutes: 0, pomodoros: 0 };
      cur.minutes += s.minutes;
      cur.pomodoros += 1;
      grouped.set(key, cur);
    }
    return [...grouped.entries()]
      .map(([taskTitle, v]) => ({ taskTitle, ...v }))
      .sort((a, b) => b.minutes - a.minutes);
  }

  function categoryStats() {
    const minutes = new Map();
    const poms = new Map();
    const ratings = new Map();

    for (const s of focusSessions()) {
      const key = s.category || 'Uncategorized';
      minutes.set(key, (minutes.get(key) || 0) + s.minutes);
      poms.set(key, (poms.get(key) || 0) + 1);
      if (s.focusRating != null) {
        if (!ratings.has(key)) ratings.set(key, []);
        ratings.get(key).push(s.focusRating);
      }
    }

    const taskGroups = new Map();
    for (const t of Store.tasks()) {
      const key = t.category || 'Uncategorized';
      if (!taskGroups.has(key)) taskGroups.set(key, []);
      taskGroups.get(key).push(t);
    }

    const names = new Set([...minutes.keys(), ...poms.keys(), ...taskGroups.keys(), ...Store.categories()]);

    return [...names].map((name) => {
      const tasks = taskGroups.get(name) || [];
      const done = tasks.filter((t) => t.isDone).length;
      const r = ratings.get(name) || [];
      return {
        name,
        minutes: minutes.get(name) || 0,
        pomodoros: poms.get(name) || 0,
        avgRating: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null,
        tasksTotal: tasks.length,
        tasksDone: done,
        completion: tasks.length ? done / tasks.length : 0,
      };
    }).sort((a, b) => b.minutes - a.minutes || (b.tasksTotal - a.tasksTotal));
  }

  function sessionLocations(s) {
    const list = Array.isArray(s.locations) && s.locations.length ? s.locations : (s.location ? [s.location] : []);
    const out = [];
    for (const raw of list) {
      const v = String(raw == null ? '' : raw).trim();
      if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    }
    return out;
  }

  function locationStats() {
    const grouped = new Map();
    for (const s of focusSessions()) {
      const places = sessionLocations(s);
      const keys = places.length ? places : ['Unspecified'];
      // A session tagged Library + Home shares its minutes between the two spots so the
      // Focus Spots total stays the focus total instead of double-counting.
      const share = Number(s.minutes) / keys.length;
      for (const key of keys) {
        if (!grouped.has(key)) grouped.set(key, { minutes: 0, sessions: 0, ratings: [] });
        const g = grouped.get(key);
        g.minutes += share;
        g.sessions += 1;
        if (s.focusRating != null) g.ratings.push(s.focusRating);
      }
    }
    return [...grouped.entries()]
      .map(([name, g]) => ({
        name,
        minutes: g.minutes,
        sessions: g.sessions,
        avgRating: g.ratings.length ? g.ratings.reduce((a, b) => a + b, 0) / g.ratings.length : null,
      }))
      .sort((a, b) => b.minutes - a.minutes);
  }

  /* Sessions store raw ids ("brown", "cafe") exactly like the app does, so
     the labels are resolved for display and the ids stay intact in exports. */
  function ambienceTitle(id) {
    if (!id) return 'Silence';
    const def = Store.AMBIENCES.find((a) => a.id === id);
    return def ? def.name : id;
  }

  function ambienceStats() {
    const grouped = new Map();
    for (const s of focusSessions()) {
      const key = s.ambience || 'none';
      grouped.set(key, (grouped.get(key) || 0) + s.minutes);
    }
    return [...grouped.entries()]
      .map(([id, minutes]) => ({ id, name: ambienceTitle(id), minutes }))
      .sort((a, b) => b.minutes - a.minutes);
  }

  function ratingTrend() {
    // Day period: dailyStats is hourly, and this is one point per day
    const data = dailyStats().filter((d, i, all) => !i || dayKey(d.date) !== dayKey(all[i - 1].date));
    const sessions = focusSessions();
    return data.map((d) => {
      const dd = new Date(d.date);
      dd.setHours(0, 0, 0, 0);
      const next = new Date(dd);
      next.setDate(next.getDate() + 1);       // not +24 h: a day can be 23 or 25 hours long
      const inDay = sessions.filter((s) => {
        const t = new Date(s.start);
        return t >= dd && t < next;
      });
      const ratings = inDay.map((s) => s.focusRating).filter((r) => r != null);
      return {
        date: d.date,
        value: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
        count: ratings.length,
      };
    });
  }

  function genreStats() {
    // A session records the chosen genre, but older records may carry a
    // track title — resolve both to a genre.
    const genreOf = (value) => {
      const track = Audio.tracks().find((t) => t.title === value || t.id === value);
      return track ? track.genre : value;
    };
    const titleOf = (genre) => {
      const g = Audio.genres().find((x) => x.name === genre);
      return g ? g.title : genre;
    };

    const grouped = new Map();
    for (const s of focusSessions()) {
      if (!s.music) continue;
      const key = genreOf(s.music);
      if (!grouped.has(key)) grouped.set(key, { minutes: 0, ratings: [] });
      const g = grouped.get(key);
      g.minutes += s.minutes;
      if (s.focusRating != null) g.ratings.push(s.focusRating);
    }
    return [...grouped.entries()]
      .map(([name, g]) => ({
        name: titleOf(name),
        minutes: g.minutes,
        avgRating: g.ratings.length ? g.ratings.reduce((a, b) => a + b, 0) / g.ratings.length : null,
        rated: g.ratings.length,
      }))
      .sort((a, b) => b.minutes - a.minutes);
  }

  function completionRate() {
    const tasks = Store.tasks();
    if (!tasks.length) return 0;
    return tasks.filter((t) => t.isDone).length / tasks.length;
  }

  // ── rendering ──

  function render() {
    renderKpis();
    renderInsight();
    renderFocusChart();
    renderBestHours();
    renderTopTasks();
    renderCategoryChart();
    renderRatingChart();
    renderSpotStats();
    renderAmbienceStats();
    renderGenreStats();
    renderBreakdown();
    if (tabs.has(reportTab)) renderTab(reportTab);
  }

  // ── Overview (SPEC-V2 §5.6): 4 KPI tiles → one insight sentence → Focus by day + Best hours → Top tasks ──

  function dayKey(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

  // The rewards engine's record of a day: it remembers the goal as it was that day.
  function rewardsOf() {
    try { return typeof Rewards !== 'undefined' && Rewards.state ? Rewards.state() : null; } catch (_) { return null; }
  }
  function isoDay(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function goalDays() {
    const goal = Store.settings().dailyGoalMinutes;
    const st = rewardsOf();
    const { start, end } = range();
    const perDay = new Map();
    for (const s of focusSessions()) {
      const k = dayKey(new Date(s.start));
      perDay.set(k, (perDay.get(k) || 0) + s.minutes);
    }
    let days = 0, met = 0;
    const cursor = new Date(start);
    while (cursor <= end) {
      days++;
      const earned = st && st.days && st.days[isoDay(cursor)];
      if ((goal > 0 && (perDay.get(dayKey(cursor)) || 0) >= goal) || (earned && earned.goalBonus > 0)) met++;
      cursor.setDate(cursor.getDate() + 1);
    }
    return { days, met, goal };
  }

  function last7Active() {
    const active = new Set(Store.sessions().filter((s) => s.mode === 'focus').map((s) => dayKey(new Date(s.start))));
    // the dots sit under the streak, so with the engine loaded they mean the days that kept it
    const byDay = (rewardsOf() || { streak: {} }).streak.byDay;
    const kept = (x) => (byDay ? ['active', 'rest'].includes((byDay[isoDay(x)] || [])[0]) : active.has(dayKey(x)));
    const out = [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 6);
    for (let i = 0; i < 7; i++) {
      out.push({ on: kept(d), label: d.toLocaleDateString([], { weekday: 'short' }), today: i === 6 });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  function sessionSub() {
    const list = focusSessions();
    const short = list.filter((x) => !finished(x)).length;
    return short ? `${list.length - short} finished · ${short} cut short` : `all finished · about ${Charts.fmtMinutes(totalFocusMinutes() / list.length)} each`;
  }

  function renderKpis() {
    const row = $('#kpi-row');
    row.textContent = '';

    const focus = totalFocusMinutes();
    const sessions = totalPomodoros();
    const rated = focusSessions().filter((x) => x.focusRating != null).length;
    const rating = averageRating();
    const streak = currentStreak();
    const g = goalDays();
    const goalSub = g.goal <= 0 ? 'no daily goal set'
      : period === 'day' ? (focus >= g.goal ? 'goal met today' : `${Charts.fmtMinutes(Math.max(0, g.goal - focus))} to your goal`)
      : `daily goal met on ${g.met} of ${g.days} days`;

    const tiles = [
      { label: 'Focus time', value: Charts.fmtMinutes(focus), sub: goalSub },
      { label: 'Sessions', value: String(sessions), sub: sessions ? sessionSub() : 'none in this period yet' },
      { label: 'Streak', value: `${streak} day${streak === 1 ? '' : 's'}`, dots: last7Active() },
      { label: 'Avg rating', value: rating ? `${rating.toFixed(1)}` : '—', unit: rating ? '/10' : '', sub: rating ? `from ${rated} rating${rated === 1 ? '' : 's'}` : 'no ratings yet' },
    ];

    for (const t of tiles) {
      const div = document.createElement('div');
      div.className = 'kpi';
      const label = document.createElement('span');
      label.className = 'kpi-label';
      label.textContent = t.label;
      const value = document.createElement('span');
      value.className = 'kpi-value';
      value.textContent = t.value;
      if (t.unit) {
        const u = document.createElement('span');
        u.className = 'kpi-unit';
        u.textContent = t.unit;
        value.appendChild(u);
      }
      div.append(label, value);
      if (t.dots) {
        const dots = document.createElement('span');
        dots.className = 'kpi-dots';
        dots.setAttribute('role', 'img');
        dots.setAttribute('aria-label', `Focused on ${t.dots.filter((x) => x.on).length} of the last 7 days`);
        for (const d of t.dots) {
          const dot = document.createElement('span');
          dot.className = 'kpi-dot' + (d.on ? ' is-on' : '') + (d.today ? ' is-today' : '');
          dot.title = d.label;
          dots.appendChild(dot);
        }
        div.appendChild(dots);
      } else {
        const sub = document.createElement('span');
        sub.className = 'kpi-sub';
        sub.textContent = t.sub;
        div.appendChild(sub);
      }
      row.appendChild(div);
    }
  }

  // One insight sentence (W4: Insights.topEffectSentence); the card hides when there is none.
  function renderInsight() {
    const card = $('#insight-card');
    if (!card) return;
    let text = null;
    try { if (typeof Insights !== 'undefined' && Insights && typeof Insights.topEffectSentence === 'function') text = Insights.topEffectSentence(period); } catch (_) { text = null; }
    card.hidden = !text;
    $('#insight-text').textContent = text ? String(text) : '';
  }

  // Best hours: W4's 1 × 24 row (Insights.bestHoursRow) when it has one; otherwise a
  // plain 24-cell heat of focus minutes by hour of day in this period (--ramp-*).
  function hourStats() {
    const mins = new Array(24).fill(0);
    const count = new Array(24).fill(0);
    for (const s of focusSessions()) {
      const h = new Date(s.start).getHours();
      mins[h] += s.minutes;
      count[h] += 1;
    }
    return { mins, count };
  }
  function hourLabel(h) { return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`; }

  // Overview's second card: focus time by type of work (Breakdown splits it more ways).
  function renderBestHours() {
    const wrap = $('#hours-chart');
    if (!wrap) return;
    const groups = groupBy('type', focusSessions()).filter((g) => g.minutes > 0);
    const data = groups.map((g) => ({ label: g.label, value: g.minutes,
      sublabel: `${g.n} session${g.n === 1 ? '' : 's'}`,
      color: g.key == null ? 'var(--text-muted)' : Store.categoryColor(g.key) }));
    const draw = () => {
      if (!data.length) { wrap.textContent = ''; wrap.appendChild(Charts.emptyNote('Focus on a task with a type of work and it shows here.')); return; }
      Charts.hbars(wrap, { data, valueFormat: (v) => Charts.fmtMinutes(v), ariaLabel: 'Focus time by type of work' });
    };
    draw();
    Charts.observe(wrap, draw);
    Charts.table($('#hours-chart-table'),
      [{ label: 'Type of work' }, { label: 'Focus' }, { label: 'Sessions' }, { label: 'Avg rating' }],
      groups.map((g) => [g.label, Charts.fmtMinutes(g.minutes), String(g.n), g.avg == null ? '—' : g.avg.toFixed(1)]));
  }

  function renderFocusChart() {
    const data = dailyStats();
    const title = period === 'day' ? 'Focus by hour' : 'Focus by day';
    $('#focus-chart-title').textContent = title;

    const points = data.map((d) => {
      const date = d.date;
      const label = period === 'day'
        ? `${date.getHours() % 12 === 0 ? 12 : date.getHours() % 12}${date.getHours() < 12 ? 'am' : 'pm'}`
        : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return {
        label,
        value: Math.round(d.minutes),          // whole minutes, so the axis never shows fractions
        tipLabel: period === 'day'
          ? `${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${(d.pomodoros)} pomodoro${d.pomodoros === 1 ? '' : 's'}`
          : `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} — ${d.pomodoros} pomodoro${d.pomodoros === 1 ? '' : 's'}`,
      };
    });

    const container = $('#focus-chart');
    const draw = () => Charts.columns(container, {
      data: points,
      color: 'var(--chart-1)',   // single-series charts use the theme's chart colour (v2-themes T5)
      valueFormat: (v) => Charts.fmtMinutes(v),
      tooltipFormat: (v) => Charts.fmtMinutes(v),
      ariaLabel: `${title}. ${totalFocusMinutes()} minutes focused.`,
    });
    draw();
    Charts.observe(container, draw);

    Charts.table($('#focus-chart-table'),
      [{ label: 'When' }, { label: 'Minutes' }, { label: 'Pomodoros' }],
      data.map((d) => [
        period === 'day'
          ? d.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : d.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
        d.minutes.toFixed(1),
        String(d.pomodoros),
      ]));
  }

  function renderTopTasks() {
    const wrap = $('#top-tasks');
    wrap.textContent = '';
    const tasks = taskBreakdown();

    if (!tasks.length) {
      wrap.appendChild(Charts.emptyNote('No focused tasks in this period yet.'));
      return;
    }

    const rows = document.createElement('div');
    rows.className = 'stat-rows';

    tasks.slice(0, 6).forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'stat-row';

      const rank = document.createElement('span');
      rank.className = 'stat-rank';
      rank.textContent = String(i + 1);

      const name = document.createElement('span');
      name.className = 'stat-name';
      name.textContent = t.taskTitle;

      const value = document.createElement('span');
      value.className = 'stat-value';
      value.textContent = `${Charts.fmtMinutes(t.minutes)} · ${t.pomodoros} session${t.pomodoros === 1 ? '' : 's'}`;

      row.append(rank, name, value);
      rows.appendChild(row);
    });

    wrap.appendChild(rows);
  }

  // Breakdown › Where your focus went: by type of work, place, music or time of day. Only what you
  // actually focused on (no empty rows); "not set" sits last in grey.
  let repDim = 'type';
  const DIM_NAME = { type: 'Type of work', place: 'Place', music: 'Music', time: 'Time of day' };
  function renderCategoryChart() {
    const container = $('#category-chart');
    const groups = groupBy(repDim, focusSessions()).filter((g) => g.minutes > 0);
    const data = groups.map((g) => ({
      label: g.label, value: g.minutes,
      sublabel: `${g.n} session${g.n === 1 ? '' : 's'}`,
      color: g.key == null ? 'var(--text-muted)' : repDim === 'type' ? Store.categoryColor(g.key) : 'var(--chart-1)',
    }));
    const draw = () => Charts.hbars(container, { data, valueFormat: (v) => Charts.fmtMinutes(v), ariaLabel: `Focus time by ${DIM_NAME[repDim].toLowerCase()}` });
    draw();
    Charts.observe(container, draw);
    Charts.table($('#category-chart-table'),
      [{ label: DIM_NAME[repDim] }, { label: 'Focus time' }, { label: 'Sessions' }, { label: 'Finished' }, { label: 'Avg rating' }],
      groups.map((g) => [g.label, Charts.fmtMinutes(g.minutes), String(g.n), `${g.finished}/${g.n}`, g.avg == null ? '—' : g.avg.toFixed(1)]));
  }

  function renderRatingChart() {
    const trend = ratingTrend();
    const container = $('#rating-chart');
    const rated = trend.filter((t) => t.value != null);

    const draw = () => Charts.line(container, {
      data: trend.map((t) => ({
        label: t.date.toLocaleDateString([], { month: 'short', day: 'numeric' }),
        value: t.value,
        tipLabel: t.value == null ? 'Not rated' : `${t.count} rating${t.count === 1 ? '' : 's'}`,
      })),
      color: 'var(--series-1)',
      min: 1,
      max: 10,
      valueFormat: (v) => `${v.toFixed(1)}/10`,
      ariaLabel: 'Average focus rating over time',
    });
    draw();
    Charts.observe(container, draw);

    Charts.table($('#rating-chart-table'),
      [{ label: 'Day' }, { label: 'Average rating' }, { label: 'Ratings' }],
      trend.map((t) => [
        t.date.toLocaleDateString([], { month: 'short', day: 'numeric' }),
        t.value == null ? '—' : t.value.toFixed(1),
        String(t.count),
      ]));

    const stale = container.parentElement.querySelector('.rating-note');
    if (stale) stale.remove();
    if (!rated.length) {
      const note = document.createElement('p');
      note.className = 'muted-note rating-note';
      note.style.marginTop = '10px';
      note.textContent = 'Rate a session to see your focus trend here.';
      container.parentElement.appendChild(note);
    }
  }

  function renderSpotStats() {
    const wrap = $('#spot-stats');
    wrap.textContent = '';
    const spots = locationStats();

    if (!spots.length) {
      wrap.appendChild(Charts.emptyNote('No focus spots recorded yet. Add one to a task to see where you focus best.'));
    } else {
      const rows = document.createElement('div');
      rows.className = 'stat-rows';
      spots.slice(0, 5).forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'stat-row';
        const rank = document.createElement('span');
        rank.className = 'stat-rank';
        rank.textContent = String(i + 1);
        const name = document.createElement('span');
        name.className = 'stat-name';
        name.textContent = s.name;
        const value = document.createElement('span');
        value.className = 'stat-value';
        value.textContent = `${s.sessions} · ${Charts.fmtMinutes(s.minutes)}${s.avgRating ? ` · ${s.avgRating.toFixed(1)}★` : ''}`;
        row.append(rank, name, value);
        rows.appendChild(row);
      });
      wrap.appendChild(rows);
    }

    const container = $('#spot-chart');
    const points = spots.map((s) => ({
      label: s.name,
      value: s.minutes,
      tipValue: `${Charts.fmtMinutes(s.minutes)} · ${s.sessions} session${s.sessions === 1 ? '' : 's'}${s.avgRating ? ` · ${s.avgRating.toFixed(1)}★` : ''}`,
    }));

    const draw = () => Charts.hbars(container, {
      data: points,
      valueFormat: (v) => Charts.fmtMinutes(v),
      ariaLabel: 'Focus time by spot',
    });
    draw();
    Charts.observe(container, draw);

    Charts.table($('#spot-chart-table'),
      [{ label: 'Spot' }, { label: 'Focus time' }, { label: 'Sessions' }, { label: 'Avg rating' }],
      spots.map((s) => [
        s.name,
        Charts.fmtMinutes(s.minutes),
        String(s.sessions),
        s.avgRating ? s.avgRating.toFixed(1) : '—',
      ]));
  }

  function renderAmbienceStats() {
    const wrap = $('#ambience-stats');
    wrap.textContent = '';
    const amb = ambienceStats();

    if (!amb.length) {
      wrap.appendChild(Charts.emptyNote('No ambience recorded yet.'));
    } else {
      const rows = document.createElement('div');
      rows.className = 'stat-rows';
      amb.slice(0, 5).forEach((a, i) => {
        const row = document.createElement('div');
        row.className = 'stat-row';
        const rank = document.createElement('span');
        rank.className = 'stat-rank';
        rank.textContent = String(i + 1);
        const name = document.createElement('span');
        name.className = 'stat-name';
        name.textContent = a.name;
        const value = document.createElement('span');
        value.className = 'stat-value';
        value.textContent = Charts.fmtMinutes(a.minutes);
        row.append(rank, name, value);
        rows.appendChild(row);
      });
      wrap.appendChild(rows);
    }

    const container = $('#ambience-chart');
    const points = amb.map((a) => ({
      label: a.name,
      value: a.minutes,
      tipValue: Charts.fmtMinutes(a.minutes),
    }));

    const draw = () => Charts.hbars(container, {
      data: points,
      valueFormat: (v) => Charts.fmtMinutes(v),
      ariaLabel: 'Focus time by ambience',
    });
    draw();
    Charts.observe(container, draw);

    Charts.table($('#ambience-chart-table'),
      [{ label: 'Ambience' }, { label: 'Focus time' }],
      amb.map((a) => [
        a.name,
        Charts.fmtMinutes(a.minutes),
      ]));
  }

  function renderGenreStats() {
    const wrap = $('#genre-stats');
    wrap.textContent = '';
    const genres = genreStats();

    if (!genres.length) {
      wrap.appendChild(Charts.emptyNote('Play some background music during a session to see which genres help you focus.'));
      return;
    }

    const rows = document.createElement('div');
    rows.className = 'stat-rows';
    genres.forEach((g) => {
      const row = document.createElement('div');
      row.className = 'stat-row';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = 'var(--series-1)';
      const name = document.createElement('span');
      name.className = 'stat-name';
      name.textContent = g.name;
      const value = document.createElement('span');
      value.className = 'stat-value';
      value.textContent = `${Charts.fmtMinutes(g.minutes)}${g.avgRating ? ` · ${g.avgRating.toFixed(1)}★` : ''}`;
      row.append(sw, name, value);
      rows.appendChild(row);
    });
    wrap.appendChild(rows);
  }

  function applyBreakdownGate() {
    const pane = document.querySelector('.report-pane[data-rpane="breakdown"]');
    if (!pane || typeof PremiumGate === 'undefined') return;
    pane.dataset.pfTitle = 'Breakdown is Focus Pro';
    pane.dataset.pfDesc = 'See exactly where your focus time went — by type of work, place, music and time of day.';
    PremiumGate.lockView(pane, { title: 'Breakdown is Focus Pro', desc: 'See exactly where your focus time went — by type of work, place, music and time of day.' });
  }

  function renderBreakdown() {
    applyBreakdownGate();
    const summary = $('#breakdown-summary');
    summary.textContent = '';

    const all = sessionsInRange().filter((s) => s.mode !== 'focus' || Number(s.minutes) >= 0.5);
    const focus = focusSessions();
    const breaks = all.filter((s) => s.mode !== 'focus');

    const rows = document.createElement('div');
    rows.className = 'stat-rows';

    const add = (label, value, sub) => {
      const row = document.createElement('div');
      row.className = 'stat-row';

      const name = document.createElement('span');
      name.className = 'stat-name';
      name.textContent = label;
      if (sub) {
        const subNote = document.createElement('span');
        subNote.className = 'stat-sub';
        subNote.textContent = sub;
        name.appendChild(subNote);
      }

      const val = document.createElement('span');
      val.className = 'stat-value';
      val.textContent = value;

      row.append(name, val);
      rows.appendChild(row);
    };

    const fin = focus.filter(finished);
    const longest = focus.reduce((m, x) => Math.max(m, x.minutes), 0);
    add('Focus sessions', String(focus.length), `${Charts.fmtMinutes(focus.reduce((s, x) => s + x.minutes, 0))} total`);
    add('Finished', String(fin.length), focus.length ? `${Math.round((fin.length / focus.length) * 100)}% ran their full length` : '');
    add('Cut short', String(focus.length - fin.length), 'ended early with Skip');
    add('Breaks', String(breaks.length), `${Charts.fmtMinutes(breaks.reduce((s, x) => s + x.minutes, 0))} total`);
    add('Average focus session', `${Math.round((focus.length ? focus.reduce((s, x) => s + x.minutes, 0) / focus.length : 0))} min`, longest ? `longest ${Math.round(longest)} min` : '');

    summary.appendChild(rows);

    // Task completion
    const comp = $('#completion-summary');
    comp.textContent = '';
    // the tasks you focused on in this period, and how many of them are done now
    const ids = new Set(focus.map((x) => String(x.taskID || '').toLowerCase()).filter(Boolean));
    const tasks = Store.tasks().filter((t) => ids.has(String(t.id).toLowerCase()));
    const done = tasks.filter((t) => t.isDone).length;
    const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

    const bar = document.createElement('div');
    bar.className = 'meter';
    bar.style.marginTop = '14px';
    const fill = document.createElement('div');
    fill.className = 'meter-fill';
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    comp.appendChild(bar);

    const note = document.createElement('p');
    note.className = 'muted-note';
    note.style.marginTop = '10px';
    note.textContent = tasks.length ? `${done} of the ${tasks.length} tasks you focused on are done (${pct}%).` : 'No task-linked focus in this period yet.';
    comp.appendChild(note);

    // Session table
    const tableWrap = $('#session-table');
    tableWrap.textContent = '';
    Charts.table(tableWrap,
      [{ label: 'Start' }, { label: 'Mode' }, { label: 'Task' }, { label: 'Type' }, { label: 'Place' }, { label: 'Music' }, { label: 'Minutes' }, { label: 'Rating' }],
      all.slice().sort((a, b) => new Date(b.start) - new Date(a.start)).slice(0, 60).map((s) => [
        new Date(s.start).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
        s.mode === 'focus' ? (finished(s) ? 'Focus' : 'Focus (cut short)') : s.mode === 'shortBreak' ? 'Short break' : 'Long break',
        s.taskTitle || '—',
        s.mode === 'focus' ? (s.category || '—') : '',
        s.mode === 'focus' ? (sessionLocations(s).join(' · ') || '—') : '',
        s.mode === 'focus' ? (s.music && typeof Insights !== 'undefined' && Insights.dimLabel ? Insights.dimLabel('music', s.music) : (s.music || '—')) : '',
        Number(s.minutes).toFixed(1),
        s.focusRating != null ? `${s.focusRating}/10` : '—',
      ]));
  }

  // ── wiring ──

  function init() {
    const dimSwitch = $('#rep-dim');
    if (dimSwitch) dimSwitch.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      repDim = btn.dataset.dim;
      dimSwitch.querySelectorAll('.seg-btn').forEach((b) => { b.classList.toggle('is-active', b === btn); b.setAttribute('aria-checked', String(b === btn)); });
      renderCategoryChart();
    });
    $('#period-switch').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      period = btn.dataset.period;
      document.querySelectorAll('#period-switch .seg-btn').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });
      render();
    });

    // Start on the week view, matching the app's default.
    document.querySelectorAll('#period-switch .seg-btn').forEach((b) => {
      const active = b.dataset.period === period;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });

    $('#report-tab-switch').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      reportTab = btn.dataset.rtab;
      document.querySelectorAll('#report-tab-switch .seg-btn').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('.report-pane').forEach((pane) => {
        const active = pane.dataset.rpane === reportTab;
        pane.classList.toggle('is-active', active);
        pane.hidden = !active;
      });
      if (tabs.has(reportTab)) renderTab(reportTab);
    });

    tabsReady = true;
    Array.from(tabs.keys()).forEach(mountTab);
    applyBreakdownGate();
    if (typeof Plan !== 'undefined' && Plan.onChange) Plan.onChange(() => applyBreakdownGate());

    // Table view: a 28 px icon revealed on card hover / focus (v2-themes W10).
    document.querySelectorAll('.table-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = document.getElementById(`${btn.dataset.table}-table`);
        if (!target) return;
        const open = target.hidden;
        target.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
        btn.title = open ? 'Hide the table' : 'Show these numbers as a table';
        const lbl = btn.querySelector('.tt-lbl');
        if (lbl) lbl.textContent = open ? 'Hide table' : 'Table';
        btn.classList.toggle('is-on', open);
      });
    });

    // ⋯ menu: Export CSV · Import CSV (Settings › Data has the same).
    const moreBtn = $('#reports-more');
    const menu = $('#reports-menu');
    if (moreBtn && menu) {
      const close = (refocus) => {
        menu.hidden = true;
        moreBtn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', outside, true);
        if (refocus) moreBtn.focus();
      };
      const outside = (e) => { if (!menu.contains(e.target) && e.target !== moreBtn && !moreBtn.contains(e.target)) close(false); };
      moreBtn.addEventListener('click', () => {
        if (!menu.hidden) { close(true); return; }
        menu.hidden = false;
        moreBtn.setAttribute('aria-expanded', 'true');
        const first = menu.querySelector('[role="menuitem"]');
        if (first) first.focus();
        document.addEventListener('pointerdown', outside, true);
      });
      menu.addEventListener('click', (e) => { if (e.target.closest('[role="menuitem"]')) close(false); });
      menu.addEventListener('keydown', (e) => {
        const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); close(true); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
        }
      });
    }
  }

  function setPeriod(p) {
    period = p;
    render();
  }

  return { init, render, setPeriod, currentStreak, totalFocusMinutes, registerTab, period: () => period, tab: () => reportTab };
})();
