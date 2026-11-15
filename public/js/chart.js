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
import xychart from "../vendor/pele/diagrams/xychart.js";

register(xychart);

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

export function seriesColor(view, e, kind) {
  if (!view.split) return view.hasOther && e.slot === MAX_SLOTS - 1 ? "var(--c-other)" : `var(--c-${e.slot + 1})`;
  const step = view.slotCount <= 1 ? 0 : Math.round((e.slot * (MAX_SLOTS - 1)) / (view.slotCount - 1));
  return `var(--c-${kind === "dels" ? "del" : "add"}-${step + 1})`;
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
    // Stacked: each bar holds the running total from the bottom of its stack.
    // Declared top of the stack first, so the legend reads in stack order.
    for (const kind of kinds) {
      const running = new Float64Array(n);
      const stack = view.entities.map((e) => {
        const values = Array.from({ length: n }, (_, i) => (running[i] += value(view, e, i, kind)));
        return { entity: e, kind, values };
      });
      for (const s of stack.reverse()) {
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

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Renders a view to an <svg> element. */
export function renderSvg(view, { width, height, fontFamily, fontSize = 16, title, legend = true } = {}) {
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
  adjust(svg, view, series, fontSize);
  return svg;
}

function adjust(svg, view, series, fontSize) {
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
    const c = seriesColor(view, s.entity, s.kind);
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

  if (drawOrder.length) {
    // pele declared each stack top-first; walk it bottom-up.
    const byKind = new Map();
    for (const item of drawOrder) {
      if (!byKind.has(item.s.kind)) byKind.set(item.s.kind, []);
      byKind.get(item.s.kind).push(item);
    }
    for (const [kind, items] of byKind) {
      const up = kind !== "dels";
      const prev = new Float64Array(n).fill(NaN);
      for (const { g } of items.reverse()) {
        // pele drew one bar per month from zero to the running total; keep
        // only the part above the language below, as one stepped shape
        // spanning whole months, so there are no seams between months.
        const tops = new Float64Array(n);
        const bottoms = new Float64Array(n);
        [...g.querySelectorAll("rect")].forEach((r, i) => {
          const y = Number(r.getAttribute("y"));
          const h = Number(r.getAttribute("height"));
          const zero = up ? y + h : y;
          const far = up ? y : y + h;
          const near = Number.isNaN(prev[i]) ? zero : prev[i];
          prev[i] = far;
          let a = Math.min(near, far);
          let b = Math.max(near, far);
          // A hairline of surface between stacked languages, at the far end.
          if (b - a > 2) {
            if (up) a += 1;
            else b -= 1;
          }
          tops[i] = a;
          bottoms[i] = Math.max(a, b);
        });
        const x = (i) => (left + i * band).toFixed(2);
        let d = "";
        for (let i = 0; i < n; i++) d += `${i ? "L" : "M"}${x(i)},${tops[i].toFixed(2)}L${x(i + 1)},${tops[i].toFixed(2)}`;
        for (let i = n - 1; i >= 0; i--) d += `L${x(i + 1)},${bottoms[i].toFixed(2)}L${x(i)},${bottoms[i].toFixed(2)}`;
        g.replaceChildren(el("path", { d: `${d}Z` }));
      }
    }
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

  // Legend swatches follow the series colors; in the split view each shows
  // the language's added (top) and deleted (bottom) shade.
  const labelled = series.filter((s) => s.labelled);
  [...svg.querySelectorAll(".pele-legend-item")].forEach((item, i) => {
    const s = labelled[i];
    if (!s) return;
    item.removeAttribute("data-id");
    const swatch = item.querySelector("rect, path");
    const isLine = swatch.tagName.toLowerCase() === "path";
    const box = isLine ? swatch.getAttribute("d").match(/M([\d.]+),([\d.]+)/).slice(1).map(Number) : [Number(swatch.getAttribute("x")), Number(swatch.getAttribute("y"))];
    if (!view.split) {
      swatch.setAttribute(isLine ? "stroke" : "fill", seriesColor(view, s.entity, s.kind));
      return;
    }
    const add = seriesColor(view, s.entity, "adds");
    const del = seriesColor(view, s.entity, "dels");
    if (isLine) {
      const [x, y] = box;
      swatch.replaceWith(
        el("path", { d: `M${x},${y - 2.5}h12`, stroke: add, "stroke-width": 2, "stroke-linecap": "round" }),
        el("path", { d: `M${x},${y + 2.5}h12`, stroke: del, "stroke-width": 2, "stroke-linecap": "round" }),
      );
    } else {
      const [x, y] = box;
      swatch.replaceWith(
        el("rect", { x, y, width: 12, height: 6, rx: 1.5, fill: add }),
        el("rect", { x, y: y + 6, width: 12, height: 6, rx: 1.5, fill: del }),
      );
    }
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
export function legendEntries(view) {
  const entries = view.entities.map((e) => ({
    name: e.name,
    members: e.members,
    color: seriesColor(view, e, view.split ? "adds" : "total"),
    del: view.split ? seriesColor(view, e, "dels") : null,
  }));
  // Stacked charts list the top of the stack first, like the stack itself.
  return view.mode === "percent" ? entries.reverse() : entries;
}

/** What the tooltip shows for month i. */
export function monthDetails(view, i) {
  const rows = view.entities
    .map((e) => ({ name: e.name, members: e.members, adds: e.adds[i], dels: e.dels[i], total: e.adds[i] + e.dels[i], color: seriesColor(view, e, view.split ? "adds" : "total"), del: view.split ? seriesColor(view, e, "dels") : null }))
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
    sw.style.background = r.del ? `linear-gradient(${r.color} 50%, ${r.del} 50%)` : r.color;
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

let paint = null;
/**
 * Rewrites modern CSS colors (oklch(), color-mix()) as rgb()/rgba(), which
 * every SVG editor understands, by painting each one on a 1px canvas.
 */
function plainColors(value) {
  return value.replace(/(?:oklch|oklab|lab|lch|color-mix|color)\((?:[^()]|\([^()]*\))*\)/g, (css) => {
    paint ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = "#000";
    paint.fillStyle = css;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
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
