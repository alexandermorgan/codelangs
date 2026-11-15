// Fetches a GitHub user's accepted commits and turns them into lines changed
// per language per month. Everything runs in the browser against the public
// REST API; an optional token only raises the rate limits.
//
// Method (also explained on the page):
// 1. Find the repositories the user commits to: their own non-fork repos, repos
//    they are a member of, repos where they had pull requests merged, and repos
//    where GitHub's commit search finds commits authored by them.
// 2. For each repo, read /stats/contributors: weekly additions, deletions and
//    commit counts per author on the default branch, so only accepted
//    commits count. Repos too large for those stats fall back to the
//    additions and deletions of the user's merged pull requests.
// 3. Split each repo's lines between its languages in proportion to the bytes
//    GitHub reports for each language (/languages).

const API = "https://api.github.com";
const DAY = 86400 * 1000;
const CACHE_TTL = 12 * 3600 * 1000;
const CACHE_VERSION = 1;

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

/**
 * Adds a week of stats (week starting at `weekStart`, seconds) to a month map,
 * splitting it by day so a week that straddles two months is shared between them.
 */
export function addWeek(months, weekStart, adds, dels, commits) {
  for (let day = 0; day < 7; day++) {
    const key = monthKey(weekStart * 1000 + day * DAY);
    const row = (months[key] ??= [0, 0, 0]);
    row[0] += adds / 7;
    row[1] += dels / 7;
    row[2] += commits / 7;
  }
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

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    });
  });

// ---------- cache ----------

/** A short, non-reversible tag for a token, to keep caches apart without storing it. */
function fingerprint(token) {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** A cache backed by localStorage (or nothing, where storage is unavailable). */
export function browserCache(prefix = "commit-languages") {
  const key = (k) => `${prefix}:v${CACHE_VERSION}:${k}`;
  return {
    get(k) {
      try {
        const raw = localStorage.getItem(key(k));
        if (!raw) return null;
        const value = JSON.parse(raw);
        return Date.now() - value.at < CACHE_TTL ? value : null;
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
    if (!repos.has(k)) repos.set(k, { full, source, prs: [], ...extra });
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
    for (const item of items) {
      const full = item.repository_url.split("/repos/")[1];
      const repo = addRepo(full, "pr");
      if (item.pull_request?.merged_at) repo.prs.push({ number: item.number, mergedAt: item.pull_request.merged_at });
    }
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

// ---------- per-repo stats ----------

/** Pulls the user's weeks out of a /stats/contributors answer. */
export function contributorMonths(stats, login) {
  const lower = login.toLowerCase();
  const entry = (Array.isArray(stats) ? stats : []).find((c) => c?.author?.login?.toLowerCase() === lower);
  if (!entry) return null;
  const months = {};
  let adds = 0;
  let dels = 0;
  let commits = 0;
  for (const w of entry.weeks ?? []) {
    if (!w.a && !w.d && !w.c) continue;
    addWeek(months, w.w, w.a, w.d, w.c);
    adds += w.a;
    dels += w.d;
    commits += w.c;
  }
  return { months, adds, dels, commits };
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
  let rateLimited = null;

  let found = cache.get(cacheKey("discover"));
  if (!found) {
    try {
      found = await discover(client, login, { token, onProgress });
    } catch (err) {
      if (err instanceof RateLimitError) {
        throw new UserError(
          `GitHub's ${err.resource === "search" ? "search " : ""}rate limit was reached. ` +
            `Try again after ${new Date(err.reset).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` +
            (token ? "." : ", or add a token to raise the limit."),
        );
      }
      throw err;
    }
    cache.set(cacheKey("discover"), found);
  }
  const { user, repos } = found;

  const results = new Map(); // full -> result
  const todo = [];
  for (const repo of repos) {
    const hit = cache.get(cacheKey(`repo:${repo.full.toLowerCase()}`));
    if (hit) results.set(repo.full, hit);
    else todo.push(repo);
  }

  const total = repos.length;
  const progress = () =>
    onProgress({ phase: "stats", done: results.size, total, message: `Reading commit stats: ${results.size} of ${total} repositories` });
  const save = (repo, result) => {
    results.set(repo.full, result);
    cache.set(cacheKey(`repo:${repo.full.toLowerCase()}`), result);
    progress();
  };

  async function languagesFor(repo) {
    const res = await request(`/repos/${repo.full}/languages`);
    const langs = res.data && Object.keys(res.data).length ? res.data : { [repo.language || "Unknown"]: 1 };
    return langs;
  }

  async function fromPullRequests(repo) {
    const prs = repo.prs.slice(0, token ? 40 : 10);
    if (!prs.length) return null;
    const months = {};
    let adds = 0;
    let dels = 0;
    await pool(prs, 4, async (pr) => {
      const res = await request(`/repos/${repo.full}/pulls/${pr.number}`);
      if (!res.data) return;
      const key = monthKey(pr.mergedAt);
      const row = (months[key] ??= [0, 0, 0]);
      row[0] += res.data.additions;
      row[1] += res.data.deletions;
      row[2] += res.data.commits;
      adds += res.data.additions;
      dels += res.data.deletions;
    });
    return adds + dels > 0 ? { months, adds, dels, commits: prs.length, method: "prs" } : null;
  }

  async function finish(repo, stats) {
    let result = stats ? { ...stats, method: "stats" } : null;
    // No entry (not among the top 100 contributors) or no line counts (GitHub
    // reports zero additions for repos with 10,000+ commits): use merged PRs.
    if ((!result || result.adds + result.dels === 0) && repo.prs.length) result = (await fromPullRequests(repo)) ?? result;
    if (!result || result.adds + result.dels === 0) {
      save(repo, { status: "none" });
      return;
    }
    const languages = await languagesFor(repo);
    save(repo, { status: "ok", ...result, languages });
  }

  progress();
  let waiting = [];
  try {
    await pool(todo, token ? 6 : 4, async (repo) => {
      const res = await request(`/repos/${repo.full}/stats/contributors`);
      if (res.status === 202) waiting.push(repo);
      else await finish(repo, res.data ? contributorMonths(res.data, user.login) : null);
    });
    // GitHub computes these stats in the background on first request and answers
    // 202 meanwhile; ask again after a pause, a few times.
    for (const delay of [2000, 3000, 5000, 8000, 12000]) {
      if (!waiting.length) break;
      onProgress({
        phase: "stats",
        done: results.size,
        total,
        message: `GitHub is computing stats for ${waiting.length} ${waiting.length === 1 ? "repository" : "repositories"}…`,
      });
      await sleep(delay, signal);
      const again = waiting;
      waiting = [];
      await pool(again, 4, async (repo) => {
        const res = await request(`/repos/${repo.full}/stats/contributors`);
        if (res.status === 202) waiting.push(repo);
        else await finish(repo, res.data ? contributorMonths(res.data, user.login) : null);
      });
    }
    // Still computing: merged PRs are better than nothing.
    const still = [];
    for (const repo of waiting) {
      if (repo.prs.length) await finish(repo, null);
      else still.push(repo);
    }
    waiting = still;
  } catch (err) {
    if (!(err instanceof RateLimitError)) throw err;
    rateLimited = { reset: err.reset, resource: err.resource };
  }

  const loaded = [];
  for (const repo of repos) {
    const r = results.get(repo.full);
    if (r?.status === "ok") loaded.push({ ...r, full: repo.full, source: repo.source });
  }
  const pending = repos.filter((repo) => !results.has(repo.full)).map((repo) => repo.full);
  return { user, repos: loaded, scanned: results.size, total, pending, computing: waiting.map((r) => r.full), rateLimited, rate };
}

// ---------- aggregation ----------

/**
 * Turns per-repo month maps into per-language monthly arrays.
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
    const bytes = Object.entries(repo.languages);
    const sum = bytes.reduce((s, [, b]) => s + b, 0) || 1;
    for (const [name, b] of bytes) {
      const share = b / sum;
      if (share === 0) continue;
      let lang = byName.get(name);
      if (!lang) {
        lang = { name, adds: new Float64Array(months.length), dels: new Float64Array(months.length), total: 0 };
        byName.set(name, lang);
      }
      for (const [key, [a, d]] of Object.entries(repo.months)) {
        const i = index.get(key);
        lang.adds[i] += a * share;
        lang.dels[i] += d * share;
        lang.total += (a + d) * share;
      }
    }
  }
  const languages = [...byName.values()].filter((l) => l.total >= 0.5).sort((a, b) => b.total - a.total);
  return { months, languages };
}
