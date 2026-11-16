// Draws the language chart with pele (https://pele.run): the data becomes a
// Mermaid xychart, pele renders it to SVG, and a few adjustments are made to
// that SVG afterwards, because Mermaid's xychart has no stacked or continuous
// bars and no date axis:
//
// - Percentages are stacked bars that fill each month edge to edge, so the
//   stack reads as one continuous band per language. pele is given each
//   language's cumulative share; the bars it draws are then widened to the
//   whole month and trimmed to start where the language below ends.
// - The month/year axis is drawn here (pele would label every Nth category).
// - Colors come from CSS variables in styles.css, picked per language (never
//   by rank), so a language keeps its color whatever range is shown.

import { register, render } from "../vendor/pele/core.js";
import pie from "../vendor/pele/diagrams/pie.js";
import xychart from "../vendor/pele/diagrams/xychart.js";

register(xychart);
register(pie);

export const OTHER = "Other";
const MAX_SLOTS = 8;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SVG_NS = "http://www.w3.org/2000/svg";

export function monthLabel(key, long = false) {
  const [y, m] = key.split("-").map(Number);
  return `${(long ? MONTHS_LONG : MONTHS)[m - 1]} ${y}`;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
export const formatLines = (n) => (Math.abs(n) < 10000 ? whole.format(n) : compact.format(n));
const formatPercent = (n) => (n > 0 && n < 1 ? "<1%" : `${Math.round(n)}%`);

/**
 * Gives each language a fixed color slot from its rank over the user's whole
 * history: up to eight languages each get their own slot, otherwise the top
 * seven do and the rest share "Other".
 */
export function assignSlots(languages) {
  const own = languages.length <= MAX_SLOTS ? languages.length : MAX_SLOTS - 1;
  const slotOf = new Map();
  languages.forEach((lang, i) => slotOf.set(lang.name, i < own ? i : MAX_SLOTS - 1));
  const count = languages.length <= MAX_SLOTS ? languages.length : MAX_SLOTS;
  return { slotOf, count, hasOther: languages.length > MAX_SLOTS };
}

/**
 * The numbers for one view of the chart: months `from`..`to` (indexes into
 * data.months), and one entity per color slot that has any lines in range.
 */
export function buildView(data, slots, { from, to, mode, split }) {
  const n = to - from + 1;
  const bySlot = new Map();
  for (const lang of data.languages) {
    const slot = slots.slotOf.get(lang.name);
    let e = bySlot.get(slot);
    if (!e) {
      const name = slots.hasOther && slot === MAX_SLOTS - 1 ? OTHER : lang.name;
      e = { name, slot, adds: new Float64Array(n), dels: new Float64Array(n), members: [] };
      bySlot.set(slot, e);
    }
    e.members.push(lang.name);
    for (let i = 0; i < n; i++) {
      e.adds[i] += lang.adds[from + i];
      e.dels[i] += lang.dels[from + i];
    }
  }
  const entities = [...bySlot.values()]
    .map((e) => ({ ...e, total: e.adds.reduce((s, v) => s + v, 0) + e.dels.reduce((s, v) => s + v, 0) }))
    .filter((e) => e.total >= 0.5)
    .sort((a, b) => a.slot - b.slot);
  const totals = new Float64Array(n);
  const addTotals = new Float64Array(n);
  const delTotals = new Float64Array(n);
  for (const e of entities) {
    for (let i = 0; i < n; i++) {
      totals[i] += e.adds[i] + e.dels[i];
      addTotals[i] += e.adds[i];
      delTotals[i] += e.dels[i];
    }
  }
  return { months: data.months.slice(from, to + 1), entities, totals, addTotals, delTotals, mode, split, slotCount: slots.count, hasOther: slots.hasOther };
}

/** The value plotted for an entity in a month, before stacking. */
function value(view, e, i, kind) {
  const raw = kind === "adds" ? e.adds[i] : kind === "dels" ? -e.dels[i] : e.adds[i] + e.dels[i];
  if (view.mode !== "percent") return raw;
  return view.totals[i] > 0 ? (raw / view.totals[i]) * 100 : 0;
}

/** A language's color: the same in every view, above and below zero alike. */
export function seriesColor(view, e) {
  return view.hasOther && e.slot === MAX_SLOTS - 1 ? "var(--c-other)" : `var(--c-${e.slot + 1})`;
}

/** Its color as drawn: gray when another language is picked in the legend. */
function paint(view, e, focus) {
  return focus && focus !== e.name ? "var(--c-dim)" : seriesColor(view, e);
}

/** Makes a legend entry a toggle for picking that language. */
function makeToggle(item, name, focus) {
  item.dataset.name = name;
  item.classList.add("legend-toggle");
  item.setAttribute("tabindex", "0");
  item.setAttribute("role", "button");
  item.setAttribute("aria-pressed", String(focus === name));
  item.setAttribute("aria-label", focus === name ? `${name}: show all languages` : `Show only ${name}`);
  if (focus && focus !== name) item.setAttribute("opacity", "0.55");
}

const num = (v) => (Math.abs(v) < 0.005 ? "0" : v.toFixed(2).replace(/\.?0+$/, ""));
const quote = (s) => `"${String(s).replace(/"/g, "'")}"`;

/**
 * Mermaid source for a view, and a description of each series in the order
 * pele will draw them.
 */
function source(view, title) {
  const lines = ["xychart"];
  if (title) lines.push(`  title ${quote(title)}`);
  lines.push(`  x-axis [${view.months.map(quote).join(", ")}]`);
  const yTitle =
    view.mode === "percent"
      ? view.split
        ? "← % deleted · % added →"
        : "% of lines changed"
      : view.split
        ? "← lines deleted · added →"
        : "Lines changed";
  lines.push(`  y-axis ${quote(yTitle)}${view.mode === "percent" && !view.split ? " 0 --> 100" : ""}`);
  const series = [];
  const n = view.months.length;
  const kinds = view.split ? ["adds", "dels"] : ["total"];

  if (view.mode === "percent") {
    // Stacked: each bar holds the running total from zero, the biggest
    // language nearest zero. Declared in the same order as every other view,
    // so the legend never changes order between views.
    for (const kind of kinds) {
      const running = new Float64Array(n);
      const stack = view.entities.map((e) => {
        const values = Array.from({ length: n }, (_, i) => (running[i] += value(view, e, i, kind)));
        return { entity: e, kind, values };
      });
      for (const s of stack) {
        const labelled = kind !== "dels";
        lines.push(`  bar ${labelled ? quote(s.entity.name) + " " : ""}[${s.values.map(num).join(", ")}]`);
        series.push({ ...s, labelled });
      }
    }
  } else {
    for (const kind of kinds) {
      for (const e of view.entities) {
        const values = Array.from({ length: n }, (_, i) => value(view, e, i, kind));
        const labelled = kind !== "dels";
        lines.push(`  line ${labelled ? quote(e.name) + " " : ""}[${values.map(num).join(", ")}]`);
        series.push({ entity: e, kind, values, labelled });
      }
    }
    // An invisible flat line at zero keeps zero on the axis; removed after rendering.
    lines.push(`  line [${Array(n).fill(0).join(", ")}]`);
    series.push({ zero: true });
  }
  return { text: lines.join("\n"), series };
}

// ---------- curves ----------

/**
 * Tangents for a curve through (xs, ys) that never overshoots: between two
 * points it stays between their values, and it is flat at every peak, trough
 * and plateau (Steffen's method).
 */
function tangents(xs, ys) {
  const n = xs.length;
  const m = new Array(n).fill(0);
  if (n < 2) return m;
  const slope = (i) => (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1);
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope(i - 1);
    const s1 = slope(i);
    const h0 = xs[i] - xs[i - 1];
    const h1 = xs[i + 1] - xs[i];
    const p = (s0 * h1 + s1 * h0) / (h0 + h1 || 1);
    m[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  const end = (i, j, k) => {
    const s = slope(Math.min(i, j));
    const t = (3 * s - m[k]) / 2;
    return Math.sign(t) !== Math.sign(s) ? 0 : Math.abs(t) > 3 * Math.abs(s) ? 3 * s : t;
  };
  m[0] = n > 2 ? end(0, 1, 1) : slope(0);
  m[n - 1] = n > 2 ? end(n - 2, n - 1, n - 2) : slope(0);
  return m;
}

/** The smoothed curve through (xs, ys) as a function of x. */
function sampler(xs, ys) {
  const m = tangents(xs, ys);
  return (x) => {
    let i = 0;
    while (i < xs.length - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i] || 1;
    const t = Math.min(1, Math.max(0, (x - xs[i]) / h));
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** Rewrites an SVG polyline path ("M x,y L x,y …", possibly several) as smooth curves. */
function smoothPolylines(d) {
  return (d.match(/M[^M]*/g) ?? [])
    .map((sub) => {
      const pts = [...sub.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((p) => [Number(p[1]), Number(p[2])]);
      if (pts.length < 3) return sub;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const m = tangents(xs, ys);
      let out = `M${xs[0]},${ys[0]}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const h = (xs[i + 1] - xs[i]) / 3;
        out += `C${(xs[i] + h).toFixed(2)},${(ys[i] + h * m[i]).toFixed(2)} ${(xs[i + 1] - h).toFixed(2)},${(ys[i + 1] - h * m[i + 1]).toFixed(2)} ${xs[i + 1]},${ys[i + 1]}`;
      }
      return out;
    })
    .join("");
}

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Renders a view to an <svg> element. */
export function renderSvg(view, { width, height, fontFamily, fontSize = 16, title, legend = true, focus = null } = {}) {
  const { text, series } = source(view, title);
  const { svg: markup } = render(text, {
    fontFamily,
    fontSize,
    config: {
      xyChart: {
        width,
        height,
        showLegend: legend,
        showTitle: Boolean(title),
        xAxis: { showLabel: false, showTick: false, showTitle: false },
      },
    },
  });
  const tpl = document.createElement("template");
  tpl.innerHTML = markup;
  const svg = tpl.content.firstElementChild;
  adjust(svg, view, series, fontSize, focus);
  return svg;
}

function adjust(svg, view, series, fontSize, focus) {
  const n = view.months.length;
  const axis = svg.querySelector(".pele-axis")?.getAttribute("d") ?? "";
  const m = axis.match(/M([\d.]+),([\d.]+)V([\d.]+)M[\d.]+,[\d.]+H([\d.]+)/);
  if (!m) return;
  const [left, top, bottom, right] = m.slice(1).map(Number);
  const band = (right - left) / n;
  svg.dataset.left = left;
  svg.dataset.right = right;
  svg.dataset.top = top;
  svg.dataset.bottom = bottom;

  // Colors, and the stacked geometry.
  const groups = [...svg.querySelectorAll(".pele-plot > .pele-series")];
  const drawOrder = []; // for stacking: bottom of each stack first
  groups.forEach((g, i) => {
    const s = series[i];
    if (!s || s.zero) {
      g.remove();
      return;
    }
    const c = paint(view, s.entity, focus);
    g.setAttribute("fill", c);
    g.removeAttribute("data-id");
    g.dataset.name = s.entity.name;
    const path = g.querySelector("path");
    if (path) {
      path.setAttribute("stroke", c);
      // Dots on every month get noisy over long ranges.
      if (band < 14) for (const dot of g.querySelectorAll("circle")) dot.remove();
    }
    if (g.classList.contains("pele-bars")) drawOrder.push({ g, s });
  });
  // The picked language's lines are drawn over the gray ones.
  if (focus) for (const g of groups) if (g.isConnected && g.dataset.name === focus && g.classList.contains("pele-line")) g.parentNode.append(g);

  if (drawOrder.length) {
    // Stacked bands, smoothed. pele drew one bar per month from zero to each
    // language's running total; those bar ends give each language's
    // thickness at the middle of each month. Each thickness is smoothed with
    // a curve that never overshoots (so a band never goes negative), then all
    // of them are scaled to the smoothed total, so bands never cross and the
    // stack still ends exactly at the total (100% in the percent view).
    const byKind = new Map();
    for (const item of drawOrder) {
      if (!byKind.has(item.s.kind)) byKind.set(item.s.kind, []);
      byKind.get(item.s.kind).push(item);
    }
    const knots = [left, ...Array.from({ length: n }, (_, i) => left + (i + 0.5) * band), right];
    const step = 2.5;
    const samples = Math.max(2, Math.ceil((right - left) / step) + 1);
    const xs = Array.from({ length: samples }, (_, j) => left + ((right - left) * j) / (samples - 1));
    const separators = [];
    for (const [kind, items] of byKind) {
      const up = kind !== "dels";
      let zero = null;
      const prev = new Float64Array(n);
      const thickness = items.map(({ g }) => {
        const t = new Float64Array(n);
        [...g.querySelectorAll("rect")].forEach((r, i) => {
          const y = Number(r.getAttribute("y"));
          const h = Number(r.getAttribute("height"));
          zero ??= up ? y + h : y;
          const reach = h; // distance from zero to this language's running total
          t[i] = Math.max(0, reach - prev[i]);
          prev[i] = Math.max(prev[i], reach);
        });
        return t;
      });
      if (zero === null) continue;
      const pad = (a) => [a[0], ...a, a[n - 1]];
      const total = sampler(knots, pad(prev));
      const parts = thickness.map((t) => sampler(knots, pad(t)));
      // Boundaries at each sample: 0 = zero line, k+1 = outer edge of language k.
      const edges = Array.from({ length: items.length + 1 }, () => new Float64Array(xs.length));
      xs.forEach((x, j) => {
        const ts = parts.map((f) => Math.max(0, f(x)));
        const sum = ts.reduce((a, b) => a + b, 0);
        const scale = sum > 0 ? Math.max(0, total(x)) / sum : 0;
        let reach = 0;
        edges[0][j] = zero;
        ts.forEach((t, k) => {
          reach += t * scale;
          edges[k + 1][j] = up ? zero - reach : zero + reach;
        });
      });
      const line = (e, reverse = false) => {
        const idx = reverse ? [...xs.keys()].reverse() : [...xs.keys()];
        return idx.map((j, at) => `${at ? "L" : "M"}${xs[j].toFixed(1)},${e[j].toFixed(1)}`).join("");
      };
      items.forEach(({ g }, k) => {
        g.replaceChildren(el("path", { d: `${line(edges[k + 1])}${line(edges[k], true).replace(/^M/, "L")}Z` }));
      });
      // A hairline of surface between neighbouring languages.
      for (let k = 1; k < items.length; k++) separators.push(line(edges[k]));
    }
    if (separators.length) {
      svg.querySelector(".pele-plot").append(el("path", { class: "band-separators", d: separators.join(""), fill: "none", stroke: "var(--_bg)", "stroke-width": 1 }));
    }
  }

  // Lines, smoothed the same way: a curve through each month that never
  // overshoots, so a line never dips below zero or bulges past its peaks.
  for (const path of svg.querySelectorAll(".pele-plot > .pele-line > path")) {
    path.setAttribute("d", smoothPolylines(path.getAttribute("d")));
  }

  // Split view: the zero line between additions and deletions.
  if (view.split) {
    const zeroY = zeroLine(svg, series, view);
    if (zeroY !== null) {
      svg.querySelector(".pele-plot").after(
        el("path", { class: "zero-line", d: `M${left},${zeroY.toFixed(2)}H${right}`, stroke: "var(--_l)", "stroke-width": 1 }),
      );
    }
  }

  // Legend swatches follow the series colors, and each entry picks its language.
  const labelled = series.filter((s) => s.labelled);
  [...svg.querySelectorAll(".pele-legend-item")].forEach((item, i) => {
    const s = labelled[i];
    if (!s) return;
    item.removeAttribute("data-id");
    const swatch = item.querySelector("rect, path");
    swatch.setAttribute(swatch.tagName.toLowerCase() === "path" ? "stroke" : "fill", paint(view, s.entity, focus));
    makeToggle(item, s.entity.name, focus);
  });

  // Y-axis labels: compact numbers, percent signs, and no minus signs below
  // zero in the split view (the axis title says which side is which).
  for (const label of svg.querySelectorAll('.pele-axis-labels text[text-anchor="end"]')) {
    const v = Number(label.textContent);
    if (!Number.isFinite(v)) continue;
    const shown = view.split ? Math.abs(v) : v;
    label.textContent = view.mode === "percent" ? `${whole.format(shown)}%` : formatLines(shown);
  }

  drawMonthAxis(svg, view, { left, right, bottom, band, fontSize });

  // Hover layer (stripped from exports).
  svg.querySelector(".pele-plot").before(
    el("rect", { class: "hover-band", x: left, y: top, width: band, height: bottom - top, fill: "currentColor", opacity: 0, "pointer-events": "none" }),
  );
  svg.append(el("rect", { class: "hover-target", x: left, y: top, width: right - left, height: bottom - top, fill: "transparent" }));
}

/**
 * Pixel y of the value zero. pele draws one gridline per y-axis tick label,
 * in the same order, so the two together give the scale.
 */
function zeroLine(svg) {
  const values = [...svg.querySelectorAll('.pele-axis-labels text[text-anchor="end"]')].map((t) => Number(t.textContent));
  const ys = [...(svg.querySelector(".pele-grid")?.getAttribute("d") ?? "").matchAll(/M[\d.]+,([\d.]+)H/g)].map((m) => Number(m[1]));
  if (values.length < 2 || values.length !== ys.length || values.some((v) => !Number.isFinite(v))) return null;
  const [v0, v1, y0, y1] = [values[0], values.at(-1), ys[0], ys.at(-1)];
  if (v0 === v1) return null;
  return y0 + ((0 - v0) * (y1 - y0)) / (v1 - v0);
}

function drawMonthAxis(svg, view, { left, bottom, band, fontSize }) {
  const n = view.months.length;
  const size = Math.round(fontSize * 0.875);
  const lineHeight = Math.round(size * 1.3);
  const ticks = [];
  const year = (k) => k.slice(0, 4);
  const month = (k) => Number(k.slice(5, 7));
  const minGap = size * 3.2;

  if (n <= 36) {
    // Month names at the middle of each month, every `step` months, with the
    // year beneath the first label and each January.
    const step = [1, 2, 3, 4, 6, 12].find((s) => s * band >= minGap) ?? 12;
    let lastYear = "";
    for (let i = 0; i < n; i++) {
      const k = view.months[i];
      const due = step === 1 || (month(k) - 1) % step === 0;
      if (!due) continue;
      const lines = [MONTHS[month(k) - 1]];
      if (year(k) !== lastYear) {
        lines.push(year(k));
        lastYear = year(k);
      }
      ticks.push({ x: left + (i + 0.5) * band, lines });
    }
    if (!ticks.length) ticks.push({ x: left + 0.5 * band, lines: [MONTHS[month(view.months[0]) - 1], year(view.months[0])] });
  } else {
    // Years, at the start of January.
    const step = [1, 2, 5, 10, 20].find((s) => s * 12 * band >= minGap) ?? 20;
    for (let i = 0; i < n; i++) {
      const k = view.months[i];
      if (month(k) === 1 && Number(year(k)) % step === 0) ticks.push({ x: left + i * band, lines: [year(k)] });
    }
  }

  const rows = Math.max(...ticks.map((t) => t.lines.length));
  const g = el("g", { class: "month-axis", "font-size": size, fill: "var(--_m)", "text-anchor": "middle" });
  let d = "";
  for (const t of ticks) {
    d += `M${t.x.toFixed(2)},${bottom}v4`;
    t.lines.forEach((line, row) => g.append(el("text", { x: t.x.toFixed(2), y: (bottom + 8 + size * 0.8 + row * lineHeight).toFixed(2) }, line)));
  }
  svg.querySelector(".pele-axis").after(el("path", { class: "month-ticks", d, stroke: "var(--_b)" }), g);

  // Make room below the plot.
  const [x0, y0, w, h] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
  const extra = 10 + rows * lineHeight;
  svg.setAttribute("viewBox", `${x0} ${y0} ${w} ${h + extra}`);
  svg.setAttribute("height", String(h + extra));
}

/** Legend entries for a view, in the order the chart's own legend uses. */
export function legendEntries(view, focus = null) {
  return view.entities.map((e) => ({
    name: e.name,
    members: e.members,
    color: paint(view, e, focus),
    dimmed: Boolean(focus && focus !== e.name),
    picked: focus === e.name,
  }));
}

/** What the tooltip shows for month i. */
export function monthDetails(view, i) {
  const rows = view.entities
    .map((e) => ({ name: e.name, members: e.members, adds: e.adds[i], dels: e.dels[i], total: e.adds[i] + e.dels[i], color: seriesColor(view, e) }))
    .filter((r) => r.total >= 0.5)
    .sort((a, b) => b.total - a.total);
  return { month: view.months[i], total: view.totals[i], adds: view.addTotals[i], dels: view.delTotals[i], rows };
}

/** Wires hover/touch tooltips to a rendered chart. */
export function attachHover(svg, view, tooltip, figure) {
  const left = Number(svg.dataset.left);
  const right = Number(svg.dataset.right);
  const n = view.months.length;
  const band = (right - left) / n;
  const highlight = svg.querySelector(".hover-band");
  const target = svg.querySelector(".hover-target");
  if (!target) return;
  let shown = -1;

  const show = (evt) => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(ctm.inverse());
    const i = Math.max(0, Math.min(n - 1, Math.floor((pt.x - left) / band)));
    if (i !== shown) {
      shown = i;
      highlight.setAttribute("x", (left + i * band).toFixed(2));
      highlight.setAttribute("opacity", 0.07);
      tooltip.replaceChildren(tooltipContent(view, i));
    }
    tooltip.hidden = false;
    const box = figure.getBoundingClientRect();
    const tip = tooltip.getBoundingClientRect();
    let x = evt.clientX - box.left + 14;
    if (x + tip.width > box.width) x = evt.clientX - box.left - tip.width - 14;
    let y = evt.clientY - box.top - tip.height / 2;
    y = Math.max(0, Math.min(box.height - tip.height, y));
    tooltip.style.translate = `${Math.max(0, x)}px ${y}px`;
  };
  const hide = () => {
    shown = -1;
    highlight.setAttribute("opacity", 0);
    tooltip.hidden = true;
  };
  target.addEventListener("pointermove", show);
  target.addEventListener("pointerdown", show);
  target.addEventListener("pointerleave", hide);
}

function tooltipContent(view, i) {
  const d = monthDetails(view, i);
  const frag = document.createDocumentFragment();
  const head = document.createElement("div");
  head.className = "tip-head";
  const strong = document.createElement("strong");
  strong.textContent = monthLabel(d.month, true);
  const sub = document.createElement("span");
  sub.textContent = d.total < 0.5 ? "No lines changed" : view.split ? `+${formatLines(d.adds)} −${formatLines(d.dels)} lines` : `${formatLines(d.total)} lines changed`;
  head.append(strong, sub);
  frag.append(head);
  if (!d.rows.length) return frag;
  const list = document.createElement("ul");
  for (const r of d.rows.slice(0, 10)) {
    const li = document.createElement("li");
    const sw = document.createElement("span");
    sw.className = "tip-swatch";
    sw.style.background = r.color;
    const name = document.createElement("span");
    name.className = "tip-name";
    name.textContent = r.name;
    if (r.name === OTHER && r.members.length) name.title = r.members.join(", ");
    const val = document.createElement("span");
    val.className = "tip-value";
    if (view.split) {
      val.textContent =
        view.mode === "percent"
          ? `+${formatPercent((r.adds / d.total) * 100)} −${formatPercent((r.dels / d.total) * 100)}`
          : `+${formatLines(r.adds)} −${formatLines(r.dels)}`;
    } else {
      val.textContent = view.mode === "percent" ? formatPercent((r.total / d.total) * 100) : formatLines(r.total);
    }
    li.append(sw, name, val);
    list.append(li);
  }
  frag.append(list);
  return frag;
}

let colorCanvas = null;
/**
 * Rewrites modern CSS colors (oklch(), color-mix()) as rgb()/rgba(), which
 * every SVG editor understands, by painting each one on a 1px canvas.
 */
function plainColors(value) {
  return value.replace(/(?:oklch|oklab|lab|lch|color-mix|color)\((?:[^()]|\([^()]*\))*\)/g, (css) => {
    colorCanvas ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
    colorCanvas.clearRect(0, 0, 1, 1);
    colorCanvas.fillStyle = "#000";
    colorCanvas.fillStyle = css;
    colorCanvas.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = colorCanvas.getImageData(0, 0, 1, 1).data;
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  });
}

/**
 * A standalone copy of a rendered chart: hover layer removed, every CSS
 * variable replaced by its current value (so it looks the same anywhere,
 * in the theme it was saved from), and a solid background.
 */
export function standalone(svg, themeSource) {
  const copy = svg.cloneNode(true);
  copy.querySelector(".hover-band")?.remove();
  copy.querySelector(".hover-target")?.remove();
  for (const node of copy.querySelectorAll(".legend-toggle, .pele-slice")) {
    for (const a of ["tabindex", "role", "aria-pressed", "aria-label", "data-name"]) node.removeAttribute(a);
  }
  const computed = getComputedStyle(themeSource);
  const local = new Map();
  for (const decl of (copy.getAttribute("style") ?? "").split(";")) {
    const at = decl.indexOf(":");
    if (decl.trim().startsWith("--")) local.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
  }
  const lookup = (name) => local.get(name) ?? (computed.getPropertyValue(name).trim() || null);
  const resolve = (value) => {
    let out = value;
    for (let guard = 0; guard < 10 && out.includes("var("); guard++) {
      out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\))*[^()]*))?\)/g, (_, name, fallback) => lookup(name) ?? fallback?.trim() ?? "");
    }
    return out;
  };
  for (const node of [copy, ...copy.querySelectorAll("*")]) {
    for (const attr of [...node.attributes]) {
      if (attr.value.includes("var(")) node.setAttribute(attr.name, plainColors(resolve(attr.value)));
    }
  }
  // Drop the now-resolved private variables and the responsive sizing.
  copy.setAttribute(
    "style",
    (copy.getAttribute("style") ?? "")
      .split(";")
      .filter((d) => d.trim() && !d.trim().startsWith("--") && !/^\s*(max-width|height)\s*:/.test(d))
      .join(";"),
  );
  const [, , w, h] = copy.getAttribute("viewBox").split(/\s+/).map(Number);
  copy.setAttribute("width", w);
  copy.setAttribute("height", h);
  copy.insertBefore(el("rect", { width: "100%", height: "100%", fill: plainColors(lookup("--pele-bg") ?? "#fff") }), copy.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copy)}\n`;
}

// ---------- pie: the whole history ----------

/**
 * One entry per color slot over the whole history, biggest first, with the
 * numbers the pie's hover shows. `commitLangs` lists each loaded commit's
 * languages, so "Other" counts each commit once even when it touches several
 * of the languages folded into it.
 */
export function pieEntries(data, slots, commitLangs = []) {
  const bySlot = new Map();
  for (const lang of data.languages) {
    const slot = slots.slotOf.get(lang.name);
    let e = bySlot.get(slot);
    if (!e) {
      const name = slots.hasOther && slot === MAX_SLOTS - 1 ? OTHER : lang.name;
      e = { name, slot, members: [], adds: 0, dels: 0, first: null, last: null };
      bySlot.set(slot, e);
    }
    e.members.push(lang.name);
    for (let i = 0; i < data.months.length; i++) {
      const a = lang.adds[i];
      const d = lang.dels[i];
      e.adds += a;
      e.dels += d;
      if (a + d > 0) {
        if (e.first === null || i < e.first) e.first = i;
        if (e.last === null || i > e.last) e.last = i;
      }
    }
  }
  const entries = [...bySlot.values()].map((e) => {
    const members = new Set(e.members);
    return {
      ...e,
      total: e.adds + e.dels,
      commits: commitLangs.filter((names) => names.some((n) => members.has(n))).length,
      first: e.first === null ? null : data.months[e.first],
      last: e.last === null ? null : data.months[e.last],
    };
  });
  const sum = entries.reduce((s, e) => s + e.total, 0) || 1;
  for (const e of entries) e.share = (e.total / sum) * 100;
  return entries.filter((e) => e.total > 0).sort((a, b) => a.slot - b.slot);
}

/** Renders the all-time pie. Slices carry only their language; hover shows the rest. */
export function renderPie(entries, { fontFamily, fontSize = 15, title, focus = null, hasOther = false, maxWidth } = {}) {
  const lines = ["pie"];
  if (title) lines.push(`  title ${quote(title)}`);
  for (const e of entries) lines.push(`  ${quote(e.name)} : ${Math.max(1, Math.round(e.total))}`);
  const { svg: markup } = render(lines.join("\n"), { fontFamily, fontSize, maxWidth });
  const tpl = document.createElement("template");
  tpl.innerHTML = markup;
  const svg = tpl.content.firstElementChild;
  const byName = new Map(entries.map((e) => [e.name, e]));
  const view = { hasOther };
  // Just the languages: no percentages on the slices.
  for (const g of svg.querySelectorAll(".pele-slice-labels")) g.remove();
  for (const slice of svg.querySelectorAll(".pele-slice")) {
    const e = byName.get(slice.getAttribute("data-id"));
    if (!e) continue;
    slice.setAttribute("fill", paint(view, e, focus));
    slice.dataset.name = e.name;
  }
  for (const item of svg.querySelectorAll(".pele-legend-item")) {
    const e = byName.get(item.getAttribute("data-id"));
    if (!e) continue;
    item.querySelector("rect")?.setAttribute("fill", paint(view, e, focus));
    makeToggle(item, e.name, focus);
    item.removeAttribute("data-id");
  }
  for (const slice of svg.querySelectorAll(".pele-slice")) slice.removeAttribute("data-id");
  return svg;
}

/** Hover (and tap) on a pie slice shows that language's numbers. */
export function attachPieHover(svg, entries, tooltip, figure) {
  const byName = new Map(entries.map((e) => [e.name, e]));
  let shown = null;
  const show = (evt) => {
    const slice = evt.target.closest?.(".pele-slice");
    const e = slice && byName.get(slice.dataset.name);
    if (!e) return hide();
    if (shown !== e.name) {
      shown = e.name;
      tooltip.replaceChildren(pieTooltip(e));
    }
    tooltip.hidden = false;
    place(tooltip, figure, evt);
  };
  const hide = () => {
    shown = null;
    tooltip.hidden = true;
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hide);
}

function place(tooltip, figure, evt) {
  const box = figure.getBoundingClientRect();
  const tip = tooltip.getBoundingClientRect();
  let x = evt.clientX - box.left + 14;
  if (x + tip.width > box.width) x = evt.clientX - box.left - tip.width - 14;
  let y = evt.clientY - box.top - tip.height / 2;
  y = Math.max(0, Math.min(box.height - tip.height, y));
  tooltip.style.translate = `${Math.max(0, x)}px ${y}px`;
}

function pieTooltip(e) {
  const frag = document.createDocumentFragment();
  const head = document.createElement("div");
  head.className = "tip-head";
  const strong = document.createElement("strong");
  strong.textContent = e.name;
  const sub = document.createElement("span");
  sub.textContent = `${e.share < 1 ? "<1" : e.share.toFixed(1)}% of all lines changed`;
  head.append(strong, sub);
  const rows = [
    ["Lines changed", formatLines(e.total)],
    ["Added", `+${formatLines(e.adds)}`],
    ["Deleted", `−${formatLines(e.dels)}`],
    ["Commits", e.commits.toLocaleString()],
    ["Active", e.first === e.last ? monthLabel(e.first) : `${monthLabel(e.first)} – ${monthLabel(e.last)}`],
  ];
  if (e.name === OTHER) rows.push(["Includes", e.members.join(", ")]);
  const dl = document.createElement("dl");
  dl.className = "tip-stats";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  frag.append(head, dl);
  return frag;
}
