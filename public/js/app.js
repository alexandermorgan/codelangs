import { aggregate, browserCache, loadProfile, UserError } from "./github.js";
import {
  assignSlots,
  attachHover,
  attachPieHover,
  buildView,
  formatLines,
  legendEntries,
  monthLabel,
  OTHER,
  pieEntries,
  renderPie,
  renderSvg,
  seriesColor,
  standalone,
} from "./chart.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "codelangs:token";
const cache = browserCache();

const state = {
  login: "",
  data: null, // { months, languages }
  slots: null,
  profile: null,
  from: 0,
  to: 0,
  mode: "percent",
  split: false,
  view: null,
  controller: null,
  // The months picked on the slider, as keys, or null for everything. Kept as
  // keys so the pick holds while the data (and its month list) grows.
  range: null,
  // The language picked in a legend, shown in color while the rest are gray.
  focus: null,
  loading: false,
  // A snapshot that arrived while the pointer was on a chart, shown when it leaves.
  deferred: null,
};

// ---------- token ----------

const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
};
function showTokenState() {
  $("token-state").textContent = readToken() ? "A token is saved in this browser." : "No token saved.";
}
$("token-form").addEventListener("submit", (evt) => {
  evt.preventDefault();
  const value = $("token").value.trim();
  if (!value) return;
  try {
    localStorage.setItem(TOKEN_KEY, value);
  } catch {
    // storage unavailable
  }
  $("token").value = "";
  // Saving a token (even the same one, after editing its permissions on
  // GitHub) can change which repos are visible, so cached lists are dropped.
  cache.clearLists();
  showTokenState();
  if (state.login) load(state.login);
});
$("token-forget").addEventListener("click", () => {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable
  }
  cache.clearLists();
  showTokenState();
  if (state.login) load(state.login);
});
showTokenState();

// ---------- URL ----------

function readUrl() {
  const p = new URLSearchParams(location.search);
  return {
    login: (p.get("u") || "").trim(),
    mode: p.get("scale") === "lines" ? "lines" : "percent",
    split: p.get("view") === "split",
    from: p.get("from") || "",
    to: p.get("to") || "",
  };
}

function writeUrl(push = false) {
  const p = new URLSearchParams();
  if (state.login) p.set("u", state.login);
  if (state.mode !== "percent") p.set("scale", state.mode);
  if (state.split) p.set("view", "split");
  if (state.range) {
    p.set("from", state.range.from);
    p.set("to", state.range.to);
  }
  const url = `${location.pathname}${p.size ? `?${p}` : ""}`;
  if (url === location.pathname + location.search) return;
  history[push ? "pushState" : "replaceState"](null, "", url);
}

// ---------- loading ----------

function setStatus(text, kind = "") {
  const el = $("status");
  el.className = `status ${kind}`.trim();
  el.replaceChildren();
  if (Array.isArray(text)) el.append(...text);
  else el.textContent = text;
}

function showProfile(user) {
  $("avatar").src = `${user.avatar}${user.avatar.includes("?") ? "&" : "?"}s=96`;
  $("profile-link").href = user.url;
  $("profile-link").textContent = user.name ? `${user.name} (@${user.login})` : `@${user.login}`;
}

async function load(login, initial = {}) {
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  state.login = login;
  state.data = null;
  state.profile = null;
  state.deferred = null;
  state.loading = true;
  if (initial.from && initial.to) state.range = { from: initial.from, to: initial.to };
  document.body.classList.add("has-results");
  $("results").hidden = false;
  $("chart-area").hidden = true;
  $("avatar").removeAttribute("src");
  $("profile-link").textContent = `@${login}`;
  $("profile-link").href = `https://github.com/${encodeURIComponent(login)}`;
  $("profile-meta").textContent = "";
  $("username").value = login;
  document.title = `@${login} · Code Langs`;
  setStatus(`Looking up @${login}…`, "loading");

  const current = () => state.controller === controller && !controller.signal.aborted;
  let profile;
  try {
    profile = await loadProfile(login, {
      token: readToken(),
      signal: controller.signal,
      cache,
      onProgress: (p) => {
        if (!current()) return;
        state.progress = p.message;
        setStatus(state.data ? `${p.message} · the charts update every 5 seconds` : p.message, "loading");
      },
      // While commits are still loading, the charts show what has arrived so
      // far, updated every 5 seconds.
      onSnapshot: (snap) => {
        if (current()) show(snap);
      },
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    state.loading = false;
    if (err instanceof UserError) setStatus(err.message, "error");
    else {
      console.error(err);
      setStatus(`Something went wrong talking to GitHub (${err.message}). Try again in a moment.`, "error");
    }
    return;
  }
  if (!current()) return;
  state.loading = false;
  state.deferred = null;
  try {
    show(profile);
  } catch (err) {
    console.error(err);
    setStatus(`The data loaded, but drawing the charts failed (${err.message}).`, "error");
    return;
  }
  showNotes(profile);
  if (!state.data.languages.length && !profile.rateLimited) {
    setStatus(
      `No lines of code found in @${profile.user.login}'s accepted commits` +
        (readToken() ? ". " : " in public repositories. ") +
        "Commits only count on a repository's default branch, when GitHub links them to the account.",
      "error",
    );
  }
}

/** Shows a profile: the final one, or a snapshot taken while loading. */
function show(profile) {
  // Don't swap the charts out from under the pointer: wait until it leaves.
  if (state.loading && pointerOnChart()) {
    state.deferred = profile;
    return;
  }
  state.deferred = null;
  state.profile = profile;
  state.login = profile.user.login;
  showProfile(profile.user);
  document.title = `@${profile.user.login} · Code Langs`;
  const data = aggregate(profile);
  state.data = data;
  state.slots = assignSlots(data.languages);

  const totalAdds = profile.repos.reduce((s, r) => s + r.adds, 0);
  const totalDels = profile.repos.reduce((s, r) => s + r.dels, 0);
  const commits = profile.loadedCommits;
  $("profile-meta").textContent =
    `${commits.toLocaleString()}${state.loading ? ` of ${profile.totalCommits.toLocaleString()}` : ""} ${commits === 1 ? "commit" : "commits"} in ${profile.repos.length} ${profile.repos.length === 1 ? "repository" : "repositories"} · ` +
    `+${formatLines(totalAdds)} −${formatLines(totalDels)} lines of code · ` +
    `on GitHub since ${monthLabel(profile.user.createdAt.slice(0, 7))}`;
  renderRepoTable(profile);
  if (!data.languages.length) return;

  // The picked range, by month, if it's still inside the data; otherwise everything.
  const n = data.months.length;
  const f = state.range ? data.months.indexOf(state.range.from) : -1;
  const t = state.range ? data.months.indexOf(state.range.to) : -1;
  if (f >= 0 && t >= f) {
    state.from = f;
    state.to = t;
  } else {
    state.range = null;
    state.from = 0;
    state.to = n - 1;
  }
  setupRange();
  $("chart-area").hidden = false;
  draw();
  drawPie();
  writeUrl();
}

function pointerOnChart() {
  return $("figure").matches(":hover") || $("pie-figure").matches(":hover");
}
for (const id of ["figure", "pie-figure"]) {
  $(id).addEventListener("pointerleave", () => {
    if (state.deferred && !pointerOnChart()) show(state.deferred);
  });
}

function showNotes(profile) {
  const notes = [];
  if (profile.rateLimited) {
    const time = new Date(profile.rateLimited.reset).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const loaded =
      profile.listedRepos < profile.totalRepos
        ? `Searched ${profile.listedRepos} of ${profile.totalRepos} repositories before GitHub's rate limit was reached` +
          (profile.loadedCommits ? `, and read ${profile.loadedCommits.toLocaleString()} commits.` : ".")
        : `Read ${profile.loadedCommits.toLocaleString()} of ${profile.totalCommits.toLocaleString()} commits before GitHub's rate limit was reached; the chart shows an even sample of them.`;
    const next = readToken()
      ? ` Try again after ${time} to load the rest.`
      : ` Try again after ${time} to load the rest (progress is saved), or `;
    notes.push(loaded + next);
    if (!readToken()) {
      const a = document.createElement("a");
      a.href = "#token-section";
      a.textContent = "add a GitHub token";
      a.addEventListener("click", () => {
        $("token-details").open = true;
      });
      setStatus([notes.join(" "), a, " to raise the limit."], "error");
      return;
    }
  }
  if (profile.unlisted?.length) {
    const n = profile.unlisted.length;
    notes.push(
      `GitHub couldn't list the commits in ${n} ${n === 1 ? "repository" : "repositories"} ` +
        `(${profile.unlisted.slice(0, 3).join(", ")}${n > 3 ? ", …" : ""}), so ${n === 1 ? "it isn't" : "they aren't"} counted. Try again later to include ${n === 1 ? "it" : "them"}.`,
    );
  }
  // Token problems that would otherwise leave private work out silently.
  if (profile.denied?.length) {
    const n = profile.denied.length;
    notes.push(
      `${n} ${n === 1 ? "repository" : "repositories"} (${profile.denied.slice(0, 3).join(", ")}${n > 3 ? ", …" : ""}) ` +
        `couldn't be read: the token needs the Contents (read-only) permission. ` +
        "Edit the token on GitHub, then click Save here again.",
    );
  } else if (profile.usedToken && profile.privateRepos === 0) {
    notes.push(
      "The token didn't find any private repositories, so only public ones are counted. " +
        "If you have private ones, set the token's Repository access to “All repositories” and give it Contents (read-only), then click Save here again.",
    );
  }
  setStatus(notes.join(" "), notes.length ? "error" : "");
}

// ---------- chart ----------

function chartSize() {
  const width = Math.max(260, Math.round($("chart").clientWidth || $("figure").clientWidth - 16));
  const small = width < 560;
  return {
    width,
    height: Math.round(Math.min(480, Math.max(small ? 300 : 340, width * 0.48))),
    fontSize: small ? 13 : 15,
    fontFamily: getComputedStyle(document.body).fontFamily,
  };
}

function currentView() {
  return buildView(state.data, state.slots, { from: state.from, to: state.to, mode: state.mode, split: state.split });
}

function chartTitle(view) {
  const span = view.months.length === 1 ? monthLabel(view.months[0]) : `${monthLabel(view.months[0])} – ${monthLabel(view.months.at(-1))}`;
  const what = state.mode === "percent" ? "Share of lines changed by language" : "Lines changed by language";
  return `@${state.login} · ${what}${state.split ? ", added and deleted" : ""} · ${span}`;
}

function draw() {
  if (!state.data) return;
  const view = currentView();
  state.view = view;
  const chart = $("chart");
  if (!view.entities.length) {
    chart.replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "No lines changed in this range." }));
    renderSummary(view);
    return;
  }
  const size = chartSize();
  // On narrow screens the legend goes below the chart, leaving the plot the full width.
  const outside = size.width < 640;
  const focus = focusIn(view);
  const svg = renderSvg(view, { ...size, legend: !outside, focus });
  renderLegend(outside ? view : null, focus);
  svg.setAttribute("aria-labelledby", "chart-caption");
  $("chart-caption").textContent = `${chartTitle(view)}. ${describe(view)}`;
  chart.replaceChildren(svg);
  attachHover(svg, view, $("tooltip"), $("figure"));
  renderSummary(view);
}

function renderLegend(view, focus) {
  const list = $("legend");
  list.hidden = !view;
  if (!view) return list.replaceChildren();
  list.replaceChildren(
    ...legendEntries(view, focus).map((entry) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "legend-toggle";
      button.dataset.name = entry.name;
      button.setAttribute("aria-pressed", String(entry.picked));
      button.classList.toggle("dimmed", entry.dimmed);
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = entry.color;
      button.append(sw, entry.name);
      if (entry.name === OTHER) button.title = entry.members.join(", ");
      li.append(button);
      return li;
    }),
  );
}

/** The picked language, if the view has it (otherwise nothing is grayed out). */
function focusIn(view) {
  return state.focus && view.entities.some((e) => e.name === state.focus) ? state.focus : null;
}

// ---------- the all-time pie ----------

function pieTitle() {
  const months = state.data.months;
  return `@${state.login} · Languages by lines changed, ${monthLabel(months[0])} – ${monthLabel(months.at(-1))}`;
}

function currentPie() {
  return pieEntries(state.data, state.slots, state.profile?.commitLangs ?? []);
}

function drawPie() {
  if (!state.data) return;
  const entries = currentPie();
  const focus = state.focus && entries.some((e) => e.name === state.focus) ? state.focus : null;
  const svg = renderPie(entries, {
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: chartSize().fontSize,
    focus,
    hasOther: state.slots.hasOther,
    maxWidth: Math.max(260, $("pie").clientWidth || 600),
  });
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${pieTitle()}. ${entries.map((e) => `${e.name} ${Math.round(e.share)}%`).join(", ")}.`);
  $("pie").replaceChildren(svg);
  attachPieHover(svg, entries, $("pie-tooltip"), $("pie-figure"));
  const enlarged = svg.dataset.enlarged ? svg.dataset.enlarged.split("\n") : [];
  delete svg.dataset.enlarged;
  $("pie-note").textContent = enlarged.length
    ? `${enlarged.join(", ")} ${enlarged.length === 1 ? "is" : "are"} under 1% of all lines changed, so ${enlarged.length === 1 ? "its slice is" : "their slices are"} drawn at about 1% to be visible. Hover for the real share.`
    : "";
}

// Clicking a language in either legend shows only that language, in both
// charts; clicking it again shows them all.
function toggleFocus(name) {
  state.focus = state.focus === name ? null : name;
  $("tooltip").hidden = true;
  draw();
  drawPie();
  const again = document.querySelector(`.legend-toggle[data-name="${CSS.escape(name)}"]`);
  again?.focus({ preventScroll: true });
}
document.addEventListener("click", (evt) => {
  const toggle = evt.target instanceof Element ? evt.target.closest(".legend-toggle") : null;
  if (toggle?.dataset.name) toggleFocus(toggle.dataset.name);
});
document.addEventListener("keydown", (evt) => {
  // SVG legend entries aren't buttons, so Enter and Space are handled here.
  const toggle = evt.target instanceof Element ? evt.target.closest("svg .legend-toggle") : null;
  if (toggle?.dataset.name && (evt.key === "Enter" || evt.key === " ")) {
    evt.preventDefault();
    toggleFocus(toggle.dataset.name);
  }
});

function describe(view) {
  const ranked = [...view.entities].sort((a, b) => b.total - a.total).slice(0, 3);
  const sum = view.entities.reduce((s, e) => s + e.total, 0) || 1;
  return `Most lines changed: ${ranked.map((e) => `${e.name} ${Math.round((e.total / sum) * 100)}%`).join(", ")}.`;
}

let pending = 0;
const redraw = () => {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(draw);
};

new ResizeObserver(() => {
  if (!state.data || $("chart-area").hidden) return;
  const w = $("chart").clientWidth;
  if (w && w !== redraw.width) {
    redraw.width = w;
    redraw();
    drawPie();
  }
}).observe($("chart"));

for (const input of document.querySelectorAll('input[name="mode"], input[name="split"]')) {
  input.addEventListener("change", () => {
    state.mode = document.querySelector('input[name="mode"]:checked').value;
    state.split = document.querySelector('input[name="split"]:checked').value === "split";
    $("tooltip").hidden = true;
    draw();
    writeUrl();
  });
}

function syncControls() {
  document.querySelector(`input[name="mode"][value="${state.mode}"]`).checked = true;
  document.querySelector(`input[name="split"][value="${state.split ? "split" : "combined"}"]`).checked = true;
}

// ---------- range slider ----------

const fromInput = $("range-from");
const toInput = $("range-to");

function setupRange() {
  const n = state.data.months.length;
  for (const input of [fromInput, toInput]) {
    input.max = String(n - 1);
    input.disabled = n < 2;
  }
  fromInput.value = String(state.from);
  toInput.value = String(state.to);
  $("range-min").textContent = monthLabel(state.data.months[0]);
  $("range-max").textContent = monthLabel(state.data.months[n - 1]);
  updateRange();
}

function updateRange() {
  const months = state.data.months;
  const last = Math.max(1, months.length - 1);
  const slider = $("range-slider");
  slider.style.setProperty("--from", `${(state.from / last) * 100}%`);
  slider.style.setProperty("--to", `${(state.to / last) * 100}%`);
  // When the thumbs meet at the right end, the "from" thumb must be on top so it can still move left.
  fromInput.style.zIndex = state.from === last ? "3" : "";
  const count = state.to - state.from + 1;
  $("range-label").textContent =
    count === 1
      ? monthLabel(months[state.from], true)
      : `${monthLabel(months[state.from])} – ${monthLabel(months[state.to])} · ${count} months`;
  fromInput.setAttribute("aria-valuetext", monthLabel(months[state.from], true));
  toInput.setAttribute("aria-valuetext", monthLabel(months[state.to], true));
  $("range-reset").hidden = state.from === 0 && state.to === months.length - 1;
}

// The two thumbs can meet but never cross.
fromInput.addEventListener("input", () => {
  let v = Number(fromInput.value);
  if (v > state.to) {
    v = state.to;
    fromInput.value = String(v);
  }
  state.from = v;
  rememberRange();
  updateRange();
  redraw();
});
toInput.addEventListener("input", () => {
  let v = Number(toInput.value);
  if (v < state.from) {
    v = state.from;
    toInput.value = String(v);
  }
  state.to = v;
  rememberRange();
  updateRange();
  redraw();
});
for (const input of [fromInput, toInput]) input.addEventListener("change", () => writeUrl());
function rememberRange() {
  const months = state.data.months;
  state.range = state.from === 0 && state.to === months.length - 1 ? null : { from: months[state.from], to: months[state.to] };
}
$("range-reset").addEventListener("click", () => {
  state.range = null;
  state.from = 0;
  state.to = state.data.months.length - 1;
  fromInput.value = "0";
  toInput.value = String(state.to);
  updateRange();
  draw();
  writeUrl();
});

// ---------- tables ----------

function renderSummary(view) {
  const tbody = $("summary-table").querySelector("tbody");
  const sum = view.entities.reduce((s, e) => s + e.total, 0) || 1;
  const rows = [...view.entities].sort((a, b) => b.total - a.total);
  tbody.replaceChildren(
    ...rows.map((e) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = seriesColor(view, e);
      name.append(sw, e.name === OTHER ? `Other (${e.members.length} languages)` : e.name);
      if (e.name === OTHER) name.title = e.members.join(", ");
      const adds = e.adds.reduce((s, v) => s + v, 0);
      const dels = e.dels.reduce((s, v) => s + v, 0);
      tr.append(name, cell(`+${formatLines(adds)}`), cell(`−${formatLines(dels)}`), cell(`${((e.total / sum) * 100).toFixed(1)}%`));
      return tr;
    }),
  );
}

function renderRepoTable(profile) {
  const label = { owned: "Own repository", member: "Member", private: "Private (via token)", pr: "Merged pull requests", commits: "Commit search" };
  const tbody = $("repo-table").querySelector("tbody");
  const repos = [...profile.repos].sort((a, b) => b.adds + b.dels - (a.adds + a.dels));
  $("ignored-note").textContent = profile.ignored
    ? `Another ${formatLines(profile.ignored)} changed lines were in files that aren't counted: data and config formats, prose, lockfiles, and generated or vendored code.`
    : "";
  tbody.replaceChildren(
    ...repos.map((r) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      const a = document.createElement("a");
      a.href = `https://github.com/${r.full}`;
      a.textContent = r.full;
      name.append(a);
      const commits = r.loaded < r.commits ? `${r.loaded.toLocaleString()} of ${r.commits.toLocaleString()}` : r.commits.toLocaleString();
      tr.append(name, cell(commits), cell(`+${formatLines(r.adds)}`), cell(`−${formatLines(r.dels)}`), cell(label[r.source]));
      return tr;
    }),
  );
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

// ---------- export ----------

/** A standalone SVG of the main chart ("chart") or the all-time pie ("pie"), as shown now. */
function exportSvg(which) {
  const size = chartSize();
  let svg;
  if (which === "pie") {
    const entries = currentPie();
    const focus = state.focus && entries.some((e) => e.name === state.focus) ? state.focus : null;
    svg = renderPie(entries, { fontFamily: size.fontFamily, fontSize: 15, focus, hasOther: state.slots.hasOther, title: pieTitle() });
  } else {
    const view = currentView();
    const width = Math.max(720, size.width);
    svg = renderSvg(view, {
      ...size,
      width,
      height: Math.round(Math.max(size.height, width * 0.48)),
      fontSize: 15,
      title: chartTitle(view),
      focus: focusIn(view),
    });
  }
  // Resolve colors in the chart's own context (so the file matches the current
  // theme), inside a hidden holder so the chart itself keeps no extra styles.
  const holder = Object.assign(document.createElement("div"), { className: "export-holder" });
  holder.append(svg);
  $("figure").append(holder);
  delete svg.dataset.enlarged;
  const text = standalone(svg, $("figure"));
  holder.remove();
  return text;
}

function fileName(ext, which = "chart") {
  const months = state.data.months;
  const parts =
    which === "pie"
      ? [state.login, "languages-all-time", months[0], months.at(-1)]
      : [state.login, "languages", state.mode, state.split ? "split" : null, months[state.from], months[state.to]];
  return `${parts.filter(Boolean).join("-")}.${ext}`;
}

function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flash(button, text) {
  const label = button.querySelector("span");
  const before = label.textContent;
  label.textContent = text;
  button.setAttribute("aria-label", text);
  setTimeout(() => {
    label.textContent = before;
    button.removeAttribute("aria-label");
  }, 1600);
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(exportSvg(button.dataset.copy));
      flash(button, "Copied");
    } catch {
      flash(button, "Copy failed");
    }
  });
}
for (const button of document.querySelectorAll("[data-download]")) {
  const which = button.dataset.download;
  button.addEventListener("click", () => download(exportSvg(which), fileName("svg", which), "image/svg+xml"));
}
$("download-csv").addEventListener("click", () => {
  const rows = [["month", "language", "lines_added", "lines_deleted"]];
  for (let i = state.from; i <= state.to; i++) {
    for (const lang of state.data.languages) {
      const a = lang.adds[i];
      const d = lang.dels[i];
      if (a + d >= 0.5) rows.push([state.data.months[i], lang.name, Math.round(a), Math.round(d)]);
    }
  }
  const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n");
  download(`${csv}\n`, fileName("csv"), "text/csv");
});

// ---------- search & navigation ----------

$("search").addEventListener("submit", (evt) => {
  evt.preventDefault();
  const login = $("username").value.trim().replace(/^@/, "");
  if (!login) return;
  state.range = null;
  state.focus = null;
  state.login = login;
  state.data = null;
  writeUrl(true);
  load(login);
});

document.addEventListener("click", (evt) => {
  const a = evt.target instanceof Element ? evt.target.closest("a[data-user]") : null;
  if (!a || evt.metaKey || evt.ctrlKey || evt.shiftKey) return;
  evt.preventDefault();
  state.login = a.dataset.user;
  state.data = null;
  state.range = null;
  state.focus = null;
  writeUrl(true);
  load(a.dataset.user);
});

function fromUrl() {
  const u = readUrl();
  state.mode = u.mode;
  state.split = u.split;
  syncControls();
  if (!u.login) {
    state.controller?.abort();
    state.login = "";
    state.data = null;
    document.body.classList.remove("has-results");
    $("results").hidden = true;
    $("username").value = "";
    document.title = "Code Langs";
    return;
  }
  if (u.login.toLowerCase() === state.login.toLowerCase() && state.data) {
    const f = state.data.months.indexOf(u.from);
    const t = state.data.months.indexOf(u.to);
    state.from = f >= 0 ? f : 0;
    state.to = t >= state.from ? t : state.data.months.length - 1;
    rememberRange();
    setupRange();
    draw();
    return;
  }
  state.range = null;
  load(u.login, u);
}

addEventListener("popstate", fromUrl);
fromUrl();
