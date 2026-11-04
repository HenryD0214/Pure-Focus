/* ═══════════════════════════════════════════════════════════════════════
   charts.js — chart primitives

   Built to the data-viz method:
     · form chosen by the data's job (magnitude → bars, trend → line)
     · categorical hues assigned in fixed order, never cycled
     · mark specs: bars <= 24px with 4px rounded data-ends, 2px lines,
       >= 8px markers with a 2px surface ring, hairline solid gridlines
     · every chart ships a hover layer AND a table-view twin
   ═══════════════════════════════════════════════════════════════════════ */

const Charts = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* The categorical palette. Slots 1-3 validate all-pairs in both modes,
     so the three category hues are safe to use together anywhere. */
  const CATEGORICAL = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
                       'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];

  const MAX_BAR = 24;      // px — never fill the band
  const GAP = 2;           // px surface gap between touching marks
  const RADIUS = 4;        // px rounded data-end

  let tooltipEl = null;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function el(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined) node.setAttribute(k, String(v));
    }
    return node;
  }

  function text(str, attrs = {}) {
    const node = el('text', attrs);
    node.textContent = str;
    return node;
  }

  /* Shortens a label to roughly `px` wide (≈ 6.6 px per character at 12 px). */
  function clip(str, px) {
    const s = String(str == null ? '' : str);
    const max = Math.max(4, Math.floor(px / 6.6));
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /* ── tooltip layer ── */

  function ensureTooltip(container) {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'chart-tooltip';
      document.body.appendChild(tooltipEl);
    }
    if (tooltipEl.parentElement !== container) container.appendChild(tooltipEl);
    return tooltipEl;
  }

  function showTooltip(container, x, y, rows, heading) {
    const tip = ensureTooltip(container);
    tip.textContent = '';

    if (heading) {
      const h = document.createElement('div');
      h.className = 'tt-label';
      h.textContent = heading;
      tip.appendChild(h);
    }

    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'tt-label';

      if (row.color) {
        const key = document.createElement('span');
        key.className = 'tt-key';
        key.style.background = row.color;
        line.appendChild(key);
      }

      const value = document.createElement('span');
      value.className = 'tt-value';
      value.textContent = row.value;
      line.appendChild(value);

      const name = document.createElement('span');
      name.textContent = row.label;
      line.appendChild(name);

      tip.appendChild(line);
    }

    const rect = container.getBoundingClientRect();
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(4, y - 10)}px`;
    tip.classList.add('is-visible');
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.classList.remove('is-visible');
  }

  /* ── axis helpers ── */

  function niceTicks(max, count = 4) {
    if (!Number.isFinite(max) || max <= 0) return [0, 1];
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const ticks = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
    if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toFixed(6)));
    return ticks;
  }

  function fmt(v) {
    if (!Number.isFinite(v)) return '0';
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(1);
  }

  function fmtMinutes(m) {
    if (!Number.isFinite(m)) return '0m';
    const whole = Math.floor(m);
    const mins = whole % 60;
    const hours = Math.floor(whole / 60);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  /* Rounded data-end column: rounded at the top, square on the baseline. */
  function columnPath(x, y, w, h) {
    const r = Math.min(RADIUS, w / 2, Math.max(0, h));
    if (h <= 0.4) return `M ${x} ${y + h} L ${x + w} ${y + h}`;
    return `M ${x} ${y + h} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} ` +
           `L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h} Z`;
  }

  /* Rounded data-end horizontal bar: rounded at the right, square on the axis. */
  function barPath(x, y, w, h) {
    const r = Math.min(RADIUS, h / 2, Math.max(0, w));
    if (w <= 0.4) return `M ${x} ${y} L ${x} ${y + h}`;
    return `M ${x} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} ` +
           `L ${x + w} ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} L ${x} ${y + h} Z`;
  }

  /* ─────────────────────────  COLUMN CHART  ─────────────────────────
     Job: compare magnitude across time. One series -> one hue, no legend
     (the card title names what is plotted).                        */

  function columns(container, opts) {
    const {
      data = [],            // [{ label, value, sublabel }]
      color = 'var(--series-1)',
      valueFormat = fmt,
      tooltipFormat = null,
      height = 220,
      xTickEvery = null,
      ariaLabel = 'Column chart',
    } = opts;

    container.textContent = '';
    if (!data.length) {
      container.appendChild(emptyNote('No sessions recorded in this period yet.'));
      return;
    }

    const width = Math.max(260, container.clientWidth || 520);
    const padL = 40, padR = 14, padT = 18, padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const max = Math.max(...data.map((d) => d.value), 0);
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const yOf = (v) => padT + plotH - (v / top) * plotH;

    const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': ariaLabel });

    // Gridlines — hairline, solid, recessive.
    for (const t of ticks) {
      const y = yOf(t);
      svg.appendChild(el('line', { class: 'grid-line', x1: padL, x2: width - padR, y1: y, y2: y }));
      svg.appendChild(text(fmt(t), { class: 'axis-text', x: padL - 8, y: y + 3.5, 'text-anchor': 'end' }));
    }
    svg.appendChild(el('line', { class: 'axis-line', x1: padL, x2: width - padR, y1: yOf(0), y2: yOf(0) }));

    // Columns. Band width shared; the bar is capped and the leftover is air.
    const band = plotW / data.length;
    const barW = Math.max(3, Math.min(MAX_BAR, band - Math.max(GAP, band * 0.35)));

    const maxIdx = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);

    data.forEach((d, i) => {
      const cx = padL + band * i + band / 2;
      const x = cx - barW / 2;
      const y = yOf(d.value);
      const h = yOf(0) - y;

      const path = el('path', { class: 'bar-mark', d: columnPath(x, y, barW, h), fill: color });
      svg.appendChild(path);

      // Hit target spans the whole band and at least 24px.
      const hit = el('rect', {
        x: padL + band * i, y: padT, width: band, height: plotH,
        fill: 'transparent', style: 'cursor:pointer',
      });
      svg.appendChild(hit);

      const show = () => showTooltip(container, cx, y, [{
        color, value: (tooltipFormat || valueFormat)(d.value), label: d.tipLabel || d.label,
      }], d.tipHeading || null);
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointermove', show);
      hit.addEventListener('pointerleave', hideTooltip);

      // Direct-label only the extreme — never a number on every column.
      if (i === maxIdx && d.value > 0) {
        svg.appendChild(text(valueFormat(d.value), {
          class: 'value-label', x: cx, y: y - 7, 'text-anchor': 'middle',
        }));
      }

      // X ticks — thinned so labels never collide.
      const every = xTickEvery || Math.ceil(data.length / Math.max(3, Math.floor(plotW / 54)));
      // the last label only when it isn't crowding the one before it
      if (i % every === 0 || (i === data.length - 1 && i % every >= Math.ceil(every / 2))) {
        svg.appendChild(text(d.label, {
          class: 'axis-text', x: cx, y: height - 8, 'text-anchor': 'middle',
        }));
      }
    });

    container.appendChild(svg);
  }

  /* ─────────────────────────  HORIZONTAL BARS  ─────────────────────────
     Job: compare magnitude across named categories. Bars are capped at
     24px; the value rides the tip when it fits, else it goes to the
     tooltip and the table view.                                     */

  function hbars(container, opts) {
    const {
      data = [],              // [{ label, value, color, tipValue }]
      valueFormat = fmt,
      height = null,
      ariaLabel = 'Bar chart',
      maxBars = 8,
    } = opts;

    container.textContent = '';
    if (!data.length) {
      container.appendChild(emptyNote('Nothing to show for this period yet.'));
      return;
    }

    const rows = data.slice(0, maxBars);
    const width = Math.max(260, container.clientWidth || 520);
    const labelW = Math.min(148, Math.max(84, Math.round(width * 0.28)));
    const valueW = 62;
    const hasSub = rows.some((d) => d.sublabel);   // optional muted second line under the label (v2)
    const rowH = hasSub ? 40 : 30;
    const barH = Math.min(MAX_BAR, rowH - 12);
    const padT = 6;
    const h = height || (rows.length * rowH + padT + 6);
    const plotW = Math.max(40, width - labelW - valueW - 12);

    const max = Math.max(...rows.map((d) => d.value), 0);
    const svg = el('svg', { width, height: h, viewBox: `0 0 ${width} ${h}`, role: 'img', 'aria-label': ariaLabel });

    rows.forEach((d, i) => {
      const y = padT + i * rowH;
      const cy = y + rowH / 2;
      const w = max > 0 ? (d.value / max) * plotW : 0;
      const color = d.color || 'var(--series-1)';

      svg.appendChild(text(clip(d.label, labelW - 8), {
        class: 'cat-label', x: 0, y: hasSub && d.sublabel ? cy - 2 : cy + 4, fill: 'var(--text-secondary)',
      }));
      if (hasSub && d.sublabel) {
        svg.appendChild(text(clip(d.sublabel, labelW - 8), { class: 'axis-text', x: 0, y: cy + 12 }));
      }

      // A faint track shows the scale behind each bar.
      svg.appendChild(el('rect', {
        x: labelW, y: cy - barH / 2, width: plotW, height: barH,
        rx: RADIUS, fill: 'var(--gridline)', opacity: 0.35,
      }));

      if (w > 0) {
        svg.appendChild(el('path', { class: 'bar-mark', d: barPath(labelW, cy - barH / 2, w, barH), fill: color }));
      }

      // Value at the tip, outside the bar — never clipped inside it.
      svg.appendChild(text(valueFormat(d.value), {
        class: 'value-label', x: width, y: cy + 4, 'text-anchor': 'end',
      }));

      const hit = el('rect', {
        x: 0, y, width, height: rowH, fill: 'transparent', style: 'cursor:pointer',
      });
      svg.appendChild(hit);

      const show = () => showTooltip(container, labelW + w, cy - 6, [{
        color, value: d.tipValue || valueFormat(d.value), label: d.label,
      }], null);
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointermove', show);
      hit.addEventListener('pointerleave', hideTooltip);
    });

    container.appendChild(svg);
  }

  /* ─────────────────────────  LINE CHART  ─────────────────────────
     Job: trend over time. Single series -> one hue, 2px line, >= 8px
     end markers with a 2px surface ring, crosshair on hover.        */

  function line(container, opts) {
    const {
      data = [],             // [{ label, value, tipLabel }]
      color = 'var(--series-1)',
      height = 200,
      valueFormat = fmt,
      min = null,
      max: maxOverride = null,
      ariaLabel = 'Line chart',
      area = false,          // v2: a 10 % wash under the line (zone trend)
      ticks = null,          // optional explicit gridline values, e.g. [0, 50, 100]
      tickFormat = fmt,
    } = opts;

    container.textContent = '';
    const points = data.filter((d) => d.value != null);
    if (points.length < 2) {
      container.appendChild(emptyNote('Not enough data to draw a trend yet.'));
      return;
    }

    const width = Math.max(260, container.clientWidth || 520);
    const padL = 38, padR = 18, padT = 18, padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const values = points.map((p) => p.value);
    let lo = min != null ? min : Math.min(...values);
    let hi = maxOverride != null ? maxOverride : Math.max(...values);
    if (hi === lo) { hi = lo + 1; lo = Math.max(0, lo - 1); }
    const span = hi - lo;

    const xOf = (i) => padL + (plotW * i) / (points.length - 1);
    const yOf = (v) => padT + plotH - ((v - lo) / span) * plotH;

    const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': ariaLabel });

    // Gridlines at nice steps across the value range.
    const tickCount = 3;
    const tickVals = Array.isArray(ticks) && ticks.length ? ticks : Array.from({ length: tickCount + 1 }, (_, i) => lo + (span * i) / tickCount);
    for (const v of tickVals) {
      const y = yOf(v);
      svg.appendChild(el('line', { class: 'grid-line', x1: padL, x2: width - padR, y1: y, y2: y }));
      svg.appendChild(text(tickFormat(v), { class: 'axis-text', x: padL - 8, y: y + 3.5, 'text-anchor': 'end' }));
    }
    svg.appendChild(el('line', { class: 'axis-line', x1: padL, x2: width - padR, y1: yOf(lo), y2: yOf(lo) }));

    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(i)} ${yOf(p.value)}`).join(' ');
    if (area) {
      svg.appendChild(el('path', {
        d: `${d} L ${xOf(points.length - 1)} ${yOf(lo)} L ${xOf(0)} ${yOf(lo)} Z`, fill: color, opacity: 0.1, stroke: 'none',
      }));
    }
    svg.appendChild(el('path', {
      d, fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    // Crosshair — the reader aims at a date, not a 2px line.
    const crosshair = el('line', {
      class: 'grid-line', x1: 0, x2: 0, y1: padT, y2: padT + plotH,
      stroke: 'var(--text-muted)', opacity: 0,
    });
    svg.appendChild(crosshair);

    // Markers: >= 8px, each with a 2px surface ring.
    points.forEach((p, i) => {
      const cx = xOf(i);
      const cy = yOf(p.value);
      const marker = el('circle', {
        cx, cy, r: 4.5, fill: color, stroke: 'var(--chart-surface)', 'stroke-width': 2,
      });
      svg.appendChild(marker);
    });

    // Direct-label the endpoint only.
    const last = points[points.length - 1];
    svg.appendChild(text(valueFormat(last.value), {
      class: 'value-label', x: xOf(points.length - 1), y: yOf(last.value) - 12, 'text-anchor': 'end',
    }));

    // X labels, thinned.
    const every = Math.ceil(points.length / Math.max(3, Math.floor(plotW / 58)));
    points.forEach((p, i) => {
      if (i % every !== 0 && !(i === points.length - 1 && i % every >= Math.ceil(every / 2))) return;
      svg.appendChild(text(p.label, {
        class: 'axis-text', x: xOf(i), y: height - 8, 'text-anchor': 'middle',
      }));
    });

    // Hit layer — the pointer only has to be closest, not dead-centre.
    const hit = el('rect', {
      x: padL - 12, y: padT, width: plotW + 24, height: plotH, fill: 'transparent',
    });
    svg.appendChild(hit);

    const move = (evt) => {
      const rect = svg.getBoundingClientRect();
      const px = ((evt.clientX - rect.left) / rect.width) * width;
      let best = 0;
      let bestDist = Infinity;
      points.forEach((p, i) => {
        const d2 = Math.abs(xOf(i) - px);
        if (d2 < bestDist) { bestDist = d2; best = i; }
      });
      const p = points[best];
      const cx = xOf(best);
      crosshair.setAttribute('x1', cx);
      crosshair.setAttribute('x2', cx);
      crosshair.setAttribute('opacity', 0.5);
      const rect2 = container.getBoundingClientRect();
      const scale = rect2.width / width;
      showTooltip(container, cx * scale, yOf(p.value) * scale, [{
        color, value: valueFormat(p.value), label: p.tipLabel || p.label,
      }], p.tipHeading || null);
    };

    hit.addEventListener('pointerenter', move);
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => { crosshair.setAttribute('opacity', 0); hideTooltip(); });

    container.appendChild(svg);
  }

  /* ─────────────────────────  TABLE VIEW  ─────────────────────────
     The WCAG-clean twin every chart ships with.                    */

  function table(container, columns, rows) {
    container.textContent = '';

    if (!rows.length) {
      container.appendChild(emptyNote('No rows to show.'));
      return;
    }

    const t = document.createElement('table');
    t.className = 'data-table';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const c of columns) {
      const th = document.createElement('th');
      th.textContent = c.label;
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    t.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      row.forEach((cell, i) => {
        const td = document.createElement('td');
        if (i === 0 && typeof cell === 'object' && cell !== null && cell.swatch) {
          const wrap = document.createElement('span');
          wrap.className = 'swatch-cell';
          const sw = document.createElement('span');
          sw.className = 'legend-swatch';
          sw.style.background = cell.swatch;
          wrap.appendChild(sw);
          wrap.appendChild(document.createTextNode(cell.text));
          td.appendChild(wrap);
        } else {
          td.textContent = cell;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    t.appendChild(tbody);
    container.appendChild(t);
  }

  function emptyNote(msg) {
    const p = document.createElement('p');
    p.className = 'chart-empty';
    p.textContent = msg;
    return p;
  }

  /* A legend is always present for two or more series — identity is never
     carried by colour alone. Built from the same marks the chart draws. */
  function legend(container, entries, shape = 'rect') {
    if (!entries || entries.length < 2) return;

    let row = container.querySelector('.legend-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'legend-row';
      container.appendChild(row);
    }
    row.textContent = '';

    for (const e of entries) {
      const item = document.createElement('span');
      item.className = 'legend-item';

      const key = document.createElement('span');
      key.className = shape === 'line' ? 'legend-line' : 'legend-swatch';
      key.style.background = e.color;
      item.appendChild(key);

      const label = document.createElement('span');
      label.textContent = e.label;
      item.appendChild(label);

      row.appendChild(item);
    }
  }

  /* Re-render on container resize so charts fill their card. */
  function observe(container, render) {
    if (container._chartObserver) container._chartObserver.disconnect();
    const ro = new ResizeObserver(() => {
      if (container.offsetParent === null) return;
      render();
    });
    ro.observe(container);
    container._chartObserver = ro;
  }

  /* ═════════════════════  v2 primitives (Insights v2 · W4; v2-guard §6.3–§6.4)  ═════════════════════
     Colours are theme tokens only (validated per theme in v2-themes): ordinal steps use
     --ramp-1…5 (0 = --fill-inset), single series --chart-1, the second series / negative side
     --chart-2. Every chart below has a table twin built by its caller with Charts.table.   */

  const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const RAMP = (k) => (k > 0 ? `var(--ramp-${k})` : 'var(--fill-inset, rgba(127, 127, 127, 0.14))');
  const TRACK = 'color-mix(in srgb, var(--tint-graphic, var(--focus-tint)) 20%, transparent)';

  /* Quintile steps (nearest rank) for a flat list — the same rule as InsightsCore.bestWindows:
     0 = nothing, 1 + the number of thresholds a value exceeds. */
  function quintileSteps(values) {
    const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
    const rank = (p) => (nz.length ? nz[Math.min(nz.length, Math.max(1, Math.ceil(p * nz.length))) - 1] : 0);
    const q = [0.2, 0.4, 0.6, 0.8].map(rank);
    return values.map((v) => (v > 0 ? 1 + q.filter((x) => v > x).length : 0));
  }

  function hourLabel(h) {
    const x = ((h % 24) + 24) % 24;
    return (x % 12 === 0 ? 12 : x % 12) + (x < 12 ? 'a' : 'p');
  }

  /* ─────────────────────────  HEATMAP  ─────────────────────────
     heatmap(container, {grid, steps, rowLabels, marks, cellLabel(r, fromHour, toHour, minutes), ariaLabel})
     grid/steps: rows × 24 (minutes; steps 0–5). marks: [{row, rows?, from, to, n}] → a 1.5 px outline + a
     numbered badge (best windows). Cells = clamp(8, ⌊(innerW − 28 − 23·2)/24⌋, 22) with a 2 px gap;
     below 560 px of inner width the hours pair up into 12 two-hour columns. Hover, or keyboard
     focus + arrows, shows a tooltip. A single row with no label is the Overview "Best hours" strip. */
  function heatmap(container, opts) {
    const { grid = [], steps = null, rowLabels = [], marks = [], cellLabel = null, ariaLabel = 'Heatmap',
      compactBelow = 560, maxCell = 22 } = opts;
    container.textContent = '';
    const innerW = Math.max(160, container.clientWidth || 600);
    const compact = innerW < compactBelow;
    const n = compact ? 12 : 24;
    const span = compact ? 2 : 1;
    const labelW = rowLabels.some(Boolean) ? 28 : 0;
    const gap = 2;
    const lead = labelW ? labelW + gap : 0;
    const cell = compact ? clampN(Math.floor((innerW - lead - (n - 1) * gap) / n), 8, 34)
      : clampN(Math.floor((innerW - lead - 23 * gap) / 24), 8, maxCell);
    const vals = grid.map((row) => {
      const out = [];
      for (let c = 0; c < n; c++) { let v = 0; for (let k = 0; k < span; k++) v += Number(row[c * span + k]) || 0; out.push(v); }
      return out;
    });
    let st;
    if (!compact && steps) st = steps;
    else {
      const flat = quintileSteps([].concat(...vals));
      st = vals.map((row, r) => row.map((_, c) => flat[r * n + c]));
    }

    const wrap = document.createElement('div');
    wrap.className = 'hm' + (compact ? ' is-compact' : '');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', ariaLabel);
    wrap.tabIndex = 0;
    const g = document.createElement('div');
    g.className = 'hm-grid';
    g.style.gridTemplateColumns = (labelW ? `${labelW}px ` : '') + `repeat(${n}, ${cell}px)`;
    g.style.gridAutoRows = `${cell}px`;
    g.style.gap = `${gap}px`;
    const cells = [];
    vals.forEach((row, r) => {
      if (labelW) {
        const l = document.createElement('span');
        l.className = 'hm-label';
        l.textContent = rowLabels[r] || '';
        g.appendChild(l);
      }
      row.forEach((v, c) => {
        const k = st[r] ? st[r][c] || 0 : 0;
        const node = document.createElement('span');
        node.className = 'hm-cell';
        node.dataset.step = String(k);
        node.style.background = RAMP(k);
        node.dataset.tip = cellLabel ? cellLabel(r, c * span, c * span + span, v) : `${hourLabel(c * span)} · ${fmtMinutes(v)}`;
        g.appendChild(node);
        cells.push(node);
      });
    });
    wrap.appendChild(g);

    // hour axis: every 3 h (24 columns) or every 6 h (12 two-hour columns)
    const axis = document.createElement('div');
    axis.className = 'hm-axis';
    axis.style.gridTemplateColumns = g.style.gridTemplateColumns;
    axis.style.columnGap = `${gap}px`;
    if (labelW) axis.appendChild(document.createElement('span'));
    for (let c = 0; c < n; c++) {
      const s = document.createElement('span');
      const hour = c * span;
      if (hour % (compact ? 6 : 3) === 0) s.textContent = hourLabel(hour);
      axis.appendChild(s);
    }
    wrap.appendChild(axis);

    // best-window outlines + numbered badges
    for (const m of marks) {
      const c0 = Math.floor(m.from / span), c1 = Math.ceil(m.to / span);
      if (m.row == null || c1 <= c0) continue;
      const o = document.createElement('span');
      o.className = 'hm-mark';
      o.style.left = `${lead + c0 * (cell + gap) - 2}px`;
      o.style.top = `${m.row * (cell + gap) - 2}px`;
      o.style.width = `${(c1 - c0) * (cell + gap) - gap + 4}px`;
      o.style.height = `${(m.rows || 1) * (cell + gap) - gap + 4}px`;   // m.rows > 1: a daily window spans every row
      if (m.n) {
        const b = document.createElement('span');
        b.className = 'hm-badge';
        b.textContent = String(m.n);
        o.appendChild(b);
      }
      wrap.appendChild(o);
    }

    const show = (node) => {
      const cr = container.getBoundingClientRect(), nr = node.getBoundingClientRect();
      showTooltip(container, nr.left - cr.left + nr.width / 2, nr.top - cr.top - 2, [{ value: node.dataset.tip, label: '' }], null);
    };
    let active = -1;
    const setActive = (i) => {
      if (active >= 0 && cells[active]) cells[active].classList.remove('is-active');
      active = clampN(i, 0, cells.length - 1);
      cells[active].classList.add('is-active');
      show(cells[active]);
    };
    g.addEventListener('pointerover', (e) => { const t = e.target.closest('.hm-cell'); if (t) show(t); });
    g.addEventListener('pointerleave', hideTooltip);
    wrap.addEventListener('focus', () => setActive(active >= 0 ? active : 0));
    wrap.addEventListener('blur', () => { if (active >= 0 && cells[active]) cells[active].classList.remove('is-active'); hideTooltip(); });
    wrap.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: n, ArrowUp: -n }[e.key];
      if (!d) return;
      e.preventDefault();
      const next = active + d;
      if (next >= 0 && next < cells.length) setActive(next);
    });
    container.appendChild(wrap);
    return wrap;
  }

  /* ─────────────────────────  PLAN COLUMNS  ─────────────────────────
     planColumns(container, {days: [{label, planned, kept, unplanned, tipHeading}]})
     Per day a ghost column (planned, tint track) behind a stacked column: kept (--chart-1) and
     unplanned focus (--text-muted at 45 %), 2 px surface gap between segments, bars ≤ 24 px.
     Plot 160 + a 20 px x-axis band. */
  function planColumns(container, opts) {
    const { days = [], ariaLabel = 'Planned focus and what you kept, by day' } = opts;
    container.textContent = '';
    if (!days.length) { container.appendChild(emptyNote('No planned blocks in this period yet.')); return; }
    const width = Math.max(260, container.clientWidth || 520);
    const height = 192;
    const padL = 40, padR = 10, padT = 12, padB = 20;
    const plotW = width - padL - padR, plotH = height - padT - padB;
    const max = Math.max(...days.map((d) => Math.max(d.planned || 0, (d.kept || 0) + (d.unplanned || 0))), 0);
    const hours = max >= 120;
    const ticks = hours ? niceTicks(max / 60).map((t) => t * 60) : niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const yOf = (v) => padT + plotH - (v / top) * plotH;
    const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': ariaLabel });
    for (const t of ticks) {
      const y = yOf(t);
      svg.appendChild(el('line', { class: 'grid-line', x1: padL, x2: width - padR, y1: y, y2: y }));
      svg.appendChild(text(hours ? `${fmt(t / 60)}h` : `${fmt(t)}m`, { class: 'axis-text', x: padL - 8, y: y + 3.5, 'text-anchor': 'end' }));
    }
    svg.appendChild(el('line', { class: 'axis-line', x1: padL, x2: width - padR, y1: yOf(0), y2: yOf(0) }));
    const band = plotW / days.length;
    const barW = Math.max(3, Math.min(MAX_BAR, band - Math.max(GAP, band * 0.35)));
    const every = Math.ceil(days.length / Math.max(3, Math.floor(plotW / 44)));
    days.forEach((d, i) => {
      const cx = padL + band * i + band / 2, x = cx - barW / 2, base = yOf(0);
      const planned = d.planned || 0, kept = d.kept || 0, un = d.unplanned || 0;
      if (planned > 0) {
        const y = yOf(planned);
        svg.appendChild(el('path', { d: columnPath(x, y, barW, base - y), style: `fill:${TRACK}` }));
      }
      if (kept > 0) {
        const y = yOf(kept), hgt = base - y;
        svg.appendChild(el('path', { class: 'bar-mark', d: un > 0 ? `M ${x} ${base} L ${x} ${y} L ${x + barW} ${y} L ${x + barW} ${base} Z` : columnPath(x, y, barW, hgt), fill: 'var(--chart-1)' }));
      }
      if (un > 0) {
        const yb = yOf(kept) - (kept > 0 ? GAP : 0), yt = yOf(kept + un) - (kept > 0 ? GAP : 0);
        svg.appendChild(el('path', { class: 'bar-mark', d: columnPath(x, yt, barW, Math.max(0.5, yb - yt)), fill: 'var(--text-muted)', opacity: 0.45 }));
      }
      if (i % every === 0 || (i === days.length - 1 && i % every >= Math.ceil(every / 2))) {
        svg.appendChild(text(d.label, { class: 'axis-text', x: cx, y: height - 5, 'text-anchor': 'middle' }));
      }
      const hit = el('rect', { x: padL + band * i, y: padT, width: band, height: plotH, fill: 'transparent' });
      svg.appendChild(hit);
      const show = () => showTooltip(container, cx, yOf(Math.max(planned, kept + un)), [
        { color: 'var(--chart-1)', value: fmtMinutes(kept), label: 'kept to plan' },
        { value: fmtMinutes(un), label: 'unplanned focus' },
        { value: fmtMinutes(planned), label: 'planned' },
      ], d.tipHeading || d.label);
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointermove', show);
      hit.addEventListener('pointerleave', hideTooltip);
    });
    container.appendChild(svg);
    const row = document.createElement('div');
    row.className = 'legend-row';
    for (const [label, bg, ghost] of [['Kept to plan', 'var(--chart-1)'], ['Unplanned focus', 'color-mix(in srgb, var(--text-muted) 45%, transparent)'], ['Planned', TRACK, true]]) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch' + (ghost ? ' is-ghost' : '');
      sw.style.background = bg;
      item.append(sw, document.createTextNode(label));
      row.appendChild(item);
    }
    container.appendChild(row);
  }

  /* ─────────────────────────  ORDINAL BAR  ─────────────────────────
     ordinalBar(container, {segments: [{label, value, color}]}) — one 100 % stacked bar, 14 px high,
     r 7 ends, 2 px gaps, with a counted legend below. */
  function ordinalBar(container, opts) {
    const { segments = [], ariaLabel = 'Distribution', countLabel = (v) => String(v) } = opts;
    container.textContent = '';
    const total = segments.reduce((t, s) => t + (s.value || 0), 0);
    if (!total) { container.appendChild(emptyNote('Nothing to show yet.')); return; }
    const bar = document.createElement('div');
    bar.className = 'ob-bar';
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', ariaLabel + ': ' + segments.filter((s) => s.value).map((s) => `${s.label} ${countLabel(s.value)}`).join(', '));
    for (const s of segments) {
      if (!(s.value > 0)) continue;
      const seg = document.createElement('span');
      seg.className = 'ob-seg';
      seg.style.flexGrow = String(s.value);
      seg.style.background = s.color;
      seg.addEventListener('pointerenter', () => {
        const cr = container.getBoundingClientRect(), r = seg.getBoundingClientRect();
        showTooltip(container, r.left - cr.left + r.width / 2, r.top - cr.top - 2, [{ color: s.color, value: countLabel(s.value), label: s.label }], null);
      });
      seg.addEventListener('pointerleave', hideTooltip);
      bar.appendChild(seg);
    }
    container.appendChild(bar);
    const row = document.createElement('div');
    row.className = 'legend-row';
    for (const s of segments) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = s.color;
      const v = document.createElement('span');
      v.className = 'legend-count';
      v.textContent = countLabel(s.value || 0);
      item.append(sw, document.createTextNode(s.label + ' '), v);
      row.appendChild(item);
    }
    container.appendChild(row);
  }

  /* ─────────────────────────  DOT PLOT  ─────────────────────────
     dotPlot(container, {rows: [{label, value}], min: 0.5, max: 2, log: true}) — one 8 px dot per row
     (2 px surface ring) on a log axis with a 1× reference hairline and the value at the right. */
  function dotPlot(container, opts) {
    const { rows = [], min = 0.5, max = 2, log = true, ref = 1, valueFormat = (v) => '×' + v.toFixed(1),
      ariaLabel = 'Dot plot' } = opts;
    container.textContent = '';
    if (!rows.length) { container.appendChild(emptyNote('Nothing to show yet.')); return; }
    const width = Math.max(260, container.clientWidth || 520);
    const labelW = Math.min(140, Math.max(80, Math.round(width * 0.26)));
    const valueW = 48, rowH = 30, padT = 6, axisH = 18;
    const plotW = Math.max(60, width - labelW - valueW - 12);
    const height = padT + rows.length * rowH + axisH;
    const xOf = (v) => {
      const c = clampN(v, min, max);
      const f = log ? (Math.log(c) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (c - min) / (max - min);
      return labelW + f * plotW;
    };
    const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': ariaLabel });
    const plotBottom = padT + rows.length * rowH;
    svg.appendChild(el('line', { x1: xOf(ref), x2: xOf(ref), y1: padT, y2: plotBottom, stroke: 'var(--text-muted)', 'stroke-width': 1, opacity: 0.6 }));
    rows.forEach((d, i) => {
      const cy = padT + i * rowH + rowH / 2;
      svg.appendChild(text(clip(d.label, labelW - 8), { class: 'cat-label', x: 0, y: cy + 4 }));
      svg.appendChild(el('line', { class: 'grid-line', x1: labelW, x2: labelW + plotW, y1: cy, y2: cy }));
      svg.appendChild(el('circle', { cx: xOf(d.value), cy, r: 4.5, fill: 'var(--chart-1)', stroke: 'var(--chart-surface)', 'stroke-width': 2 }));
      svg.appendChild(text(valueFormat(d.value), { class: 'value-label', x: width, y: cy + 4, 'text-anchor': 'end' }));
    });
    for (const t of [min, ref, max]) {
      svg.appendChild(text('×' + fmt(t), { class: 'axis-text', x: xOf(t), y: height - 4, 'text-anchor': 'middle' }));
    }
    container.appendChild(svg);
  }

  /* ─────────────────────────  DIVERGING (mini)  ─────────────────────────
     diverging(container, {value, scale: 3, width: 96}) → a small bar centred on a --text-muted
     hairline: positive → right in --chart-1, negative → left in --chart-2 (text is never coloured). */
  function diverging(container, opts) {
    const { value = 0, scale = 3, width = 96, height = 10, ariaLabel = null } = opts || {};
    const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'dv', role: 'img',
      'aria-label': ariaLabel || `${value > 0 ? '+' : ''}${fmt(value)}` });
    const mid = width / 2;
    const w = Math.min(mid - 1, (Math.abs(value) / scale) * (mid - 1));
    if (w > 0.4) {
      const x = value >= 0 ? mid : mid - w;
      svg.appendChild(el('rect', { x, y: 1.5, width: w, height: height - 3, rx: 2, fill: value >= 0 ? 'var(--chart-1)' : 'var(--chart-2)' }));
    }
    svg.appendChild(el('line', { x1: mid, x2: mid, y1: 0, y2: height, stroke: 'var(--text-muted)', 'stroke-width': 1 }));
    if (container) container.appendChild(svg);
    return svg;
  }

  /* ─────────────────────────  METER  ─────────────────────────
     meter(container, {value: 0…1, label}) — track (tint track) + --chart-1 fill. */
  function meter(container, opts) {
    const { value = 0, label = '' } = opts || {};
    const v = clampN(Number(value) || 0, 0, 1);
    const m = document.createElement('div');
    m.className = 'ins-meter';
    m.setAttribute('role', 'meter');
    m.setAttribute('aria-valuemin', '0');
    m.setAttribute('aria-valuemax', '100');
    m.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    if (label) m.setAttribute('aria-label', label);
    m.style.background = TRACK;
    const f = document.createElement('span');
    f.className = 'ins-meter-fill';
    f.style.width = `${(v * 100).toFixed(1)}%`;
    m.appendChild(f);
    if (container) container.appendChild(m);
    return m;
  }

  /* Theme switch hook (settings.js applyTheme). DOM/SVG marks read tokens live; this re-renders an
     open Reports view so any computed colours and sizes follow. */
  function refresh() {
    try {
      const view = document.getElementById('view-reports');
      if (view && !view.hidden && typeof Reports !== 'undefined') Reports.render();
    } catch (_) { /* reports re-render on their next show */ }
  }

  return { columns, hbars, line, table, emptyNote, observe, legend, fmt, fmtMinutes, cssVar, CATEGORICAL,
    heatmap, planColumns, ordinalBar, dotPlot, diverging, meter, quintileSteps, hourLabel, refresh };
})();
