// Fetches a GitHub user's accepted commits and turns them into lines changed
// per language per month. Everything runs in the browser against the public
// REST API; a token raises the rate limits and adds private repositories.
//
// Method (also explained on the page):
// 1. Find the repositories the user commits to: their own non-fork repos, repos
//    they are a member of, private repos the token can read, repos where they
//    had pull requests merged, and repos where GitHub's commit search finds
//    commits authored by them.
// 2. In each repo, list the user's commits on the default branch (merge
//    commits skipped), so only accepted commits count.
// 3. For each commit, read its diff's file list and give each file's added and
//    deleted lines to the language of its extension (see languages.js). Files
//    that aren't code, or are generated or vendored, aren't counted.

import { languageOf } from "./languages.js";

const API = "https://api.github.com";
// Commit lists can grow, so they are refreshed after 12 hours; a commit's
// diff never changes, so it is kept for 30 days.
const LIST_TTL = 12 * 3600 * 1000;
const DIFF_TTL = 30 * 24 * 3600 * 1000;
const CACHE_VERSION = 2;
const MAX_COMMIT_PAGES = 50; // 5,000 commits per repository
const MAX_FILE_PAGES = 10; // GitHub lists at most 3,000 files per commit

export class RateLimitError extends Error {
  constructor(reset, resource) {
    super(`GitHub ${resource === "search" ? "search " : ""}rate limit reached`);
    this.name = "RateLimitError";
    this.reset = reset;
    this.resource = resource;
  }
}

export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

// ---------- months ----------

/** "YYYY-MM" for a Date or timestamp, in UTC. */
export function monthKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Every month key from start to end inclusive. */
export function monthRange(start, end) {
  const out = [];
  let [y, m] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// ---------- HTTP ----------

function createClient({ token, fetchImpl, signal }) {
  const rate = {};
  async function request(path) {
    const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(API + path, { headers, signal });
    const resource = res.headers.get("x-ratelimit-resource") || (path.startsWith("/search/") ? "search" : "core");
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000 || Date.now() + 60000;
    if (remaining !== null) {
      rate[resource] = { remaining: Number(remaining), limit: Number(res.headers.get("x-ratelimit-limit")), reset };
    }
    if (res.status === 401) throw new UserError("GitHub rejected the token. Check it or remove it, then try again.");
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      if (remaining === "0") throw new RateLimitError(reset, resource);
      if (retryAfter) throw new RateLimitError(Date.now() + retryAfter * 1000, resource);
      return { status: res.status, data: null };
    }
    if (res.status === 202 || res.status === 204) return { status: res.status, data: null };
    if (!res.ok) {
      if ([404, 409, 410, 422, 451].includes(res.status)) return { status: res.status, data: null };
      throw new Error(`GitHub answered ${res.status} for ${path}`);
    }
    return { status: res.status, data: await res.json(), link: res.headers.get("link") || "" };
  }
  return { request, rate };
}

/** Runs `fn` over `items`, `limit` at a time. Stops starting new ones once one throws. */
async function pool(items, limit, fn) {
  let next = 0;
  let failure = null;
  async function worker() {
    while (failure === null && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        failure ??= err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
}

// ---------- cache ----------

/** A short, non-reversible tag for a token, to keep caches apart without storing it. */
function fingerprint(token) {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** A cache backed by localStorage (or nothing, where storage is unavailable). */
export function browserCache(prefix = "codelangs") {
  const key = (k) => `${prefix}:v${CACHE_VERSION}:${k}`;
  return {
    get(k, ttl = LIST_TTL) {
      try {
        const raw = localStorage.getItem(key(k));
        if (!raw) return null;
        const value = JSON.parse(raw);
        return Date.now() - value.at < ttl ? value : null;
      } catch {
        return null;
      }
    },
    set(k, value) {
      try {
        localStorage.setItem(key(k), JSON.stringify({ ...value, at: Date.now() }));
      } catch {
        // Full or unavailable: try to make room by dropping this tool's older entries.
        try {
          for (const name of Object.keys(localStorage)) {
            if (name.startsWith(`${prefix}:`) && !name.endsWith(":token")) localStorage.removeItem(name);
          }
          localStorage.setItem(key(k), JSON.stringify({ ...value, at: Date.now() }));
        } catch {
          // give up quietly: caching is only an optimisation
        }
      }
    },
  };
}

export function memoryCache() {
  const map = new Map();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => map.set(k, { ...v, at: Date.now() }),
  };
}

// ---------- discovery ----------

async function discover(client, login, { token, onProgress }) {
  const { request } = client;
  onProgress({ phase: "profile", message: `Looking up @${login}…` });
  const userRes = await request(`/users/${encodeURIComponent(login)}`);
  if (userRes.status === 404 || !userRes.data) throw new UserError(`There is no GitHub user called “${login}”.`);
  const u = userRes.data;
  if (u.type === "Organization") {
    throw new UserError(`@${u.login} is an organization. Enter the username of a person.`);
  }
  const user = {
    login: u.login,
    name: u.name || "",
    avatar: u.avatar_url,
    url: u.html_url,
    createdAt: u.created_at,
  };
  const lower = user.login.toLowerCase();
  const repos = new Map(); // full name (lowercase) -> repo record

  const addRepo = (full, source, extra = {}) => {
    const k = full.toLowerCase();
    if (!repos.has(k)) repos.set(k, { full, source, ...extra });
    return repos.get(k);
  };

  // Their own repos, then repos they are a member of.
  onProgress({ phase: "repos", message: "Listing repositories…" });
  for (const type of ["owner", "member"]) {
    for (let page = 1; page <= 10; page++) {
      const res = await request(`/users/${encodeURIComponent(login)}/repos?type=${type}&per_page=100&page=${page}`);
      const list = res.data ?? [];
      for (const r of list) {
        if (r.fork || r.size === 0) continue;
        addRepo(r.full_name, type === "owner" ? "owned" : "member", { language: r.language });
      }
      if (list.length < 100) break;
    }
  }

  // With a token: private repos it can read (the lists above only show public
  // ones). The user's commits are found in them the same way as anywhere else.
  if (token) {
    onProgress({ phase: "repos", message: "Listing private repositories the token can read…" });
    for (let page = 1; page <= 10; page++) {
      const res = await request(
        `/user/repos?affiliation=owner,collaborator,organization_member&visibility=private&per_page=100&page=${page}`,
      );
      const list = res.data ?? [];
      for (const r of list) {
        if (r.fork || r.size === 0) continue;
        addRepo(r.full_name, "private", { language: r.language });
      }
      if (list.length < 100) break;
    }
  }

  // Repos where their pull requests were merged.
  onProgress({ phase: "search", message: "Searching merged pull requests…" });
  const q = (s) => encodeURIComponent(s);
  for (let page = 1; page <= (token ? 3 : 1); page++) {
    const res = await request(
      `/search/issues?q=${q(`type:pr author:${user.login} is:merged -user:${user.login}`)}&per_page=100&page=${page}`,
    );
    const items = res.data?.items ?? [];
    for (const item of items) addRepo(item.repository_url.split("/repos/")[1], "pr");
    if (items.length < 100) break;
  }

  // Repos where commit search finds their commits. Commit search also finds
  // copies of a project re-uploaded by other people (not marked as forks),
  // which would count the same commits twice, so a repo found only this way
  // must be older than the user's first commit in it and must not share most
  // of its commits with a repo already counted.
  onProgress({ phase: "search", message: "Searching commits…" });
  const found = new Map(); // repo lowercase -> { full, shas:Set, first }
  const shaRepos = new Map();
  for (let page = 1; page <= (token ? 5 : 2); page++) {
    const res = await request(
      `/search/commits?q=${q(`author:${user.login} -user:${user.login}`)}&per_page=100&page=${page}`,
    );
    const items = res.data?.items ?? [];
    for (const item of items) {
      const r = item.repository;
      if (!r || r.fork) continue;
      const k = r.full_name.toLowerCase();
      const entry = found.get(k) ?? { full: r.full_name, shas: new Set(), first: Infinity };
      entry.shas.add(item.sha);
      entry.first = Math.min(entry.first, Date.parse(item.commit?.author?.date) || Infinity);
      found.set(k, entry);
      if (!shaRepos.has(item.sha)) shaRepos.set(item.sha, new Set());
      shaRepos.get(item.sha).add(k);
    }
    if (items.length < 100) break;
  }

  const claimed = new Set();
  for (const [k, entry] of found) if (repos.has(k)) for (const sha of entry.shas) claimed.add(sha);
  const candidates = [...found.entries()]
    .filter(([k]) => !repos.has(k))
    .sort((a, b) => b[1].shas.size - a[1].shas.size)
    .slice(0, token ? 25 : 8);
  if (candidates.length) {
    onProgress({ phase: "search", message: "Checking repositories found by commit search…" });
    const checked = [];
    await pool(candidates, 4, async ([k, entry]) => {
      const res = await request(`/repos/${entry.full}`);
      const r = res.data;
      if (!r || r.fork) return;
      const created = Date.parse(r.created_at);
      if (created > entry.first) return; // created after the commit: a copy
      checked.push({ k, entry, created, language: r.language, full: r.full_name });
    });
    checked.sort((a, b) => a.created - b.created);
    for (const c of checked) {
      const shared = [...c.entry.shas].filter((sha) => claimed.has(sha)).length;
      if (shared > c.entry.shas.size / 2) continue;
      for (const sha of c.entry.shas) claimed.add(sha);
      addRepo(c.full, "commits", { language: c.language });
    }
  }

  return { user, lower, repos: [...repos.values()] };
}

// ---------- commits ----------

/** Lines added and deleted per language in one commit's file list. */
export function tallyFiles(files) {
  const langs = {};
  let ignored = 0;
  for (const f of files ?? []) {
    const a = f.additions || 0;
    const d = f.deletions || 0;
    if (!a && !d) continue;
    const lang = languageOf(f.filename);
    if (!lang) {
      ignored += a + d;
      continue;
    }
    const row = (langs[lang] ??= [0, 0]);
    row[0] += a;
    row[1] += d;
  }
  return { langs, ignored };
}

/** A stable shuffle, so a partly loaded history is an even sample of it. */
function shuffled(items, key) {
  const hash = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    return h >>> 0;
  };
  return items.map((item) => [hash(key(item)), item]).sort((a, b) => a[0] - b[0]).map(([, item]) => item);
}

/**
 * Loads everything for one user. Resolves with whatever it could load; when a
 * rate limit stops it early, `rateLimited` says when to try again, and what was
 * loaded is cached so the next try continues from there.
 */
export async function loadProfile(login, { token = "", fetchImpl = fetch.bind(globalThis), signal, onProgress = () => {}, cache = memoryCache() } = {}) {
  const client = createClient({ token, fetchImpl, signal });
  const { request, rate } = client;
  // Results depend on what the token can see, so each token gets its own cache.
  const cacheKey = (s) => `${login.toLowerCase()}:${token ? fingerprint(token) : "public"}:${s}`;
  const rateMessage = (err) =>
    `GitHub's ${err.resource === "search" ? "search " : ""}rate limit was reached. ` +
    `Try again after ${new Date(err.reset).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` +
    (token ? "." : ", or add a token to raise the limit.");

  let found = cache.get(cacheKey("discover"));
  if (!found) {
    try {
      found = await discover(client, login, { token, onProgress });
    } catch (err) {
      if (err instanceof RateLimitError) throw new UserError(rateMessage(err));
      throw err;
    }
    cache.set(cacheKey("discover"), found);
  }
  const { user, repos } = found;
  let rateLimited = null;

  // Per repo: the user's commits ([sha, authored date]) and, as they load,
  // each commit's tally ({ sha: [month, { lang: [added, deleted] }, ignored] }).
  // A commit's diff is the same whoever looks at it, so diffs are cached per
  // repo, shared between users and tokens.
  const diffKey = (full) => `diffs:${full.toLowerCase()}`;
  const state = new Map();
  for (const repo of repos) {
    state.set(repo.full, {
      list: cache.get(cacheKey(`list:${repo.full.toLowerCase()}`))?.commits ?? null,
      diffs: cache.get(diffKey(repo.full), DIFF_TTL)?.diffs ?? {},
      dirty: false,
    });
  }
  const saveDiffs = (full) => {
    const st = state.get(full);
    if (!st.dirty) return;
    st.dirty = false;
    cache.set(diffKey(full), { diffs: st.diffs });
  };

  try {
    // 1. The user's commits on each repo's default branch.
    const toList = repos.filter((repo) => !state.get(repo.full).list);
    let listed = repos.length - toList.length;
    const listProgress = () =>
      onProgress({ phase: "list", done: listed, total: repos.length, message: `Finding commits: ${listed} of ${repos.length} repositories` });
    listProgress();
    await pool(toList, token ? 6 : 3, async (repo) => {
      const commits = [];
      for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
        const res = await request(`/repos/${repo.full}/commits?author=${encodeURIComponent(user.login)}&per_page=100&page=${page}`);
        const items = Array.isArray(res.data) ? res.data : [];
        for (const c of items) {
          if ((c.parents?.length ?? 0) > 1) continue; // merge commit
          commits.push([c.sha, c.commit?.author?.date ?? c.commit?.committer?.date]);
        }
        if (items.length < 100) break;
      }
      state.get(repo.full).list = commits;
      cache.set(cacheKey(`list:${repo.full.toLowerCase()}`), { commits });
      listed++;
      listProgress();
    });

    // 2. Each commit's diff, once per commit even if it is in several repos.
    const seen = new Set();
    const todo = [];
    let total = 0;
    for (const repo of repos) {
      const st = state.get(repo.full);
      for (const [sha, date] of st.list) {
        if (seen.has(sha)) continue;
        seen.add(sha);
        total++;
        if (!st.diffs[sha]) todo.push({ repo, sha, date });
      }
    }
    let done = total - todo.length;
    const diffProgress = () =>
      onProgress({ phase: "diffs", done, total, message: `Reading commits: ${done.toLocaleString()} of ${total.toLocaleString()}` });
    diffProgress();
    let sinceSave = 0;
    await pool(shuffled(todo, (t) => t.sha), token ? 6 : 3, async ({ repo, sha, date }) => {
      const files = [];
      for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const res = await request(`/repos/${repo.full}/commits/${sha}?per_page=300&page=${page}`);
        if (!res.data) break;
        files.push(...(res.data.files ?? []));
        if (!/rel="next"/.test(res.link)) break;
      }
      const { langs, ignored } = tallyFiles(files);
      const st = state.get(repo.full);
      st.diffs[sha] = [monthKey(date), langs, ignored];
      st.dirty = true;
      done++;
      diffProgress();
      if (++sinceSave >= 25) {
        sinceSave = 0;
        saveDiffs(repo.full);
      }
    });
  } catch (err) {
    if (!(err instanceof RateLimitError)) throw err;
    rateLimited = { reset: err.reset, resource: err.resource };
  } finally {
    for (const repo of repos) saveDiffs(repo.full);
  }

  // Per-repo results, each commit counted in the first repo that has it.
  const counted = new Set();
  let totalCommits = 0;
  let loadedCommits = 0;
  let ignored = 0;
  const out = [];
  for (const repo of repos) {
    const st = state.get(repo.full);
    if (!st.list) continue;
    const months = {};
    let adds = 0;
    let dels = 0;
    let commits = 0;
    let loaded = 0;
    for (const [sha] of st.list) {
      if (counted.has(sha)) continue;
      counted.add(sha);
      commits++;
      const diff = st.diffs[sha];
      if (!diff) continue;
      loaded++;
      const [month, langs, skipped] = diff;
      ignored += skipped;
      for (const [lang, [a, d]] of Object.entries(langs)) {
        const row = ((months[month] ??= {})[lang] ??= [0, 0]);
        row[0] += a;
        row[1] += d;
        adds += a;
        dels += d;
      }
    }
    totalCommits += commits;
    loadedCommits += loaded;
    if (commits) out.push({ full: repo.full, source: repo.source, commits, loaded, adds, dels, months });
  }
  const listedRepos = repos.filter((repo) => state.get(repo.full).list).length;
  return { user, repos: out, listedRepos, totalRepos: repos.length, totalCommits, loadedCommits, ignored, rateLimited, rate };
}

// ---------- aggregation ----------

/**
 * Turns per-repo month tallies into per-language monthly arrays.
 * Returns { months: ["YYYY-MM", ...], languages: [{ name, adds, dels, total }] }
 * with languages sorted by total lines changed, largest first.
 */
export function aggregate(profile, now = Date.now()) {
  let first = monthKey(profile.user.createdAt);
  let last = monthKey(now);
  for (const repo of profile.repos) {
    for (const key of Object.keys(repo.months)) {
      if (key < first) first = key;
      if (key > last) last = key;
    }
  }
  const months = monthRange(first, last);
  const index = new Map(months.map((m, i) => [m, i]));
  const byName = new Map();
  for (const repo of profile.repos) {
    for (const [key, langs] of Object.entries(repo.months)) {
      const i = index.get(key);
      for (const [name, [a, d]] of Object.entries(langs)) {
        let lang = byName.get(name);
        if (!lang) {
          lang = { name, adds: new Float64Array(months.length), dels: new Float64Array(months.length), total: 0 };
          byName.set(name, lang);
        }
        lang.adds[i] += a;
        lang.dels[i] += d;
        lang.total += a + d;
      }
    }
  }
  const languages = [...byName.values()].filter((l) => l.total > 0).sort((a, b) => b.total - a.total);
  return { months, languages };
}
