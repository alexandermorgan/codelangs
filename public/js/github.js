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

import { headerLanguage, isHeader, languageOf } from "./languages.js";

const API = "https://api.github.com";
// Commit lists can grow, so they are refreshed after 12 hours; a commit's
// diff never changes, so it is kept for 30 days.
const LIST_TTL = 12 * 3600 * 1000;
const DIFF_TTL = 30 * 24 * 3600 * 1000;
// Bumped whenever cached data changes meaning (v3: JS/TS merged; v4: headers
// follow their commit, and commit lists note squash-merged PRs).
const CACHE_VERSION = 4;
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

// GitHub's documented limits for the REST API, besides the hourly quota
// (5,000 requests with a token, 60 without): at most 100 requests in flight,
// and at most 900 per minute to one endpoint. Requests are paced just under
// that, so a long load runs flat out without tripping the per-minute limit.
const REQUESTS_PER_SECOND = 14;
const BURST = 30;
export const CONCURRENCY = 16;

/** A token bucket: `take()` resolves when a request may start. */
export function createPacer(perSecond, burst) {
  let tokens = burst;
  let last = Date.now();
  let pausedUntil = 0;
  return {
    async take(signal) {
      for (;;) {
        const now = Date.now();
        if (now < pausedUntil) {
          await sleep(pausedUntil - now, signal);
          continue;
        }
        if (perSecond === Infinity) return;
        tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
        last = now;
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await sleep(((1 - tokens) / perSecond) * 1000, signal);
      }
    },
    /** Holds every request until `until` (GitHub asked us to slow down). */
    pause(until) {
      pausedUntil = Math.max(pausedUntil, until);
      tokens = 0;
    },
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

export function createClient({ token, fetchImpl = fetch.bind(globalThis), signal, onSlowDown = () => {}, minBackoff = 60000, requestsPerSecond = REQUESTS_PER_SECOND }) {
  const rate = {};
  const pacer = createPacer(requestsPerSecond, BURST);
  async function request(path, attempt = 0) {
    await pacer.take(signal);
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
      // Out of the hourly quota: nothing to do but stop until it resets.
      if (remaining === "0") throw new RateLimitError(reset, resource);
      // A secondary ("slow down") limit: GitHub says to wait at least a minute
      // (or as long as Retry-After says), then carry on. Everyone waits.
      const retryAfter = Number(res.headers.get("retry-after"));
      const body = retryAfter ? "" : await res.text().catch(() => "");
      if ((retryAfter || /secondary rate limit/i.test(body)) && attempt < 4) {
        const wait = Math.max(minBackoff * 2 ** attempt, retryAfter * 1000 || 0);
        pacer.pause(Date.now() + wait);
        onSlowDown(Date.now() + wait);
        return request(path, attempt + 1);
      }
      return { status: res.status, data: null };
    }
    if (res.status === 202 || res.status === 204) return { status: res.status, data: null };
    if (!res.ok) {
      if ([404, 409, 410, 422, 451].includes(res.status)) return { status: res.status, data: null };
      throw new Error(`GitHub answered ${res.status} for ${path}`);
    }
    return { status: res.status, data: await res.json(), link: res.headers.get("link") || "" };
  }

  /** A GraphQL query (needs a token). Resolves with `data`; throws if GitHub refuses it. */
  async function graphql(query, variables, attempt = 0) {
    await pacer.take(signal);
    const res = await fetchImpl(`${API}/graphql`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    if (res.status === 401) throw new UserError("GitHub rejected the token. Check it or remove it, then try again.");
    if ((res.status === 403 || res.status === 429) && attempt < 4) {
      const retryAfter = Number(res.headers.get("retry-after"));
      if (res.headers.get("x-ratelimit-remaining") !== "0" && retryAfter) {
        const wait = Math.max(minBackoff * 2 ** attempt, retryAfter * 1000);
        pacer.pause(Date.now() + wait);
        onSlowDown(Date.now() + wait);
        return graphql(query, variables, attempt + 1);
      }
    }
    if (!res.ok) throw new Error(`GitHub GraphQL answered ${res.status}`);
    const body = await res.json();
    if (!body.data) throw new Error(body.errors?.[0]?.message ?? "GitHub GraphQL returned no data");
    return body.data;
  }

  return { request, graphql, rate };
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
  // Entries from older cache versions are never read again: free their space.
  try {
    for (const name of Object.keys(localStorage)) {
      if (name.startsWith(`${prefix}:v`) && !name.startsWith(key(""))) localStorage.removeItem(name);
    }
  } catch {
    // storage unavailable
  }
  return {
    /** Drops cached repo and commit lists, keeping diffs (which never change). */
    clearLists() {
      try {
        for (const name of Object.keys(localStorage)) {
          if (name.startsWith(`${prefix}:v`) && !name.startsWith(key("diffs:"))) localStorage.removeItem(name);
        }
      } catch {
        // storage unavailable: nothing cached
      }
    },
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
    clearLists() {
      for (const k of [...map.keys()]) if (!k.startsWith("diffs:")) map.delete(k);
    },
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
  const q = (s) => encodeURIComponent(s);

  /** Every page of a repo list (up to 1,000 repos). */
  async function listPages(path) {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const res = await request(`${path}&per_page=100&page=${page}`);
      const list = Array.isArray(res.data) ? res.data : [];
      all.push(...list);
      if (list.length < 100) break;
    }
    return all.filter((r) => !r.fork && r.size !== 0);
  }
  async function searchPages(path, pages) {
    const all = [];
    for (let page = 1; page <= pages; page++) {
      const res = await request(`${path}&per_page=100&page=${page}`);
      const items = res.data?.items ?? [];
      all.push(...items);
      if (items.length < 100) break;
    }
    return all;
  }

  // These lookups don't depend on each other, so they run at the same time:
  // their own repos, repos they're a member of, private repos the token can
  // read (the public lists never show private ones), repos with their merged
  // pull requests, and repos where commit search finds their commits.
  onProgress({ phase: "repos", message: "Finding repositories…" });
  const [owned, member, privateRepos, prs, commitHits] = await Promise.all([
    listPages(`/users/${encodeURIComponent(login)}/repos?type=owner`),
    listPages(`/users/${encodeURIComponent(login)}/repos?type=member`),
    token ? listPages(`/user/repos?affiliation=owner,collaborator,organization_member&visibility=private`) : [],
    searchPages(`/search/issues?q=${q(`type:pr author:${user.login} is:merged -user:${user.login}`)}`, token ? 3 : 1),
    searchPages(`/search/commits?q=${q(`author:${user.login} -user:${user.login}`)}`, token ? 5 : 2),
  ]);
  for (const r of owned) addRepo(r.full_name, "owned");
  for (const r of member) addRepo(r.full_name, "member");
  for (const r of privateRepos) addRepo(r.full_name, "private");
  for (const item of prs) addRepo(item.repository_url.split("/repos/")[1], "pr");

  // Commit search also finds copies of a project re-uploaded by other people
  // (not marked as forks), which would count the same commits twice, so a repo
  // found only this way must be older than the user's first commit in it and
  // must not share most of its commits with a repo already counted.
  const found = new Map(); // repo lowercase -> { full, shas:Set, first }
  for (const item of commitHits) {
    const r = item.repository;
    if (!r || r.fork) continue;
    const k = r.full_name.toLowerCase();
    const entry = found.get(k) ?? { full: r.full_name, shas: new Set(), first: Infinity };
    entry.shas.add(item.sha);
    entry.first = Math.min(entry.first, Date.parse(item.commit?.author?.date) || Infinity);
    found.set(k, entry);
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
    await pool(candidates, CONCURRENCY, async ([k, entry]) => {
      const res = await request(`/repos/${entry.full}`);
      const r = res.data;
      if (!r || r.fork) return;
      const created = Date.parse(r.created_at);
      if (created > entry.first) return; // created after the commit: a copy
      checked.push({ k, entry, created, full: r.full_name });
    });
    checked.sort((a, b) => a.created - b.created);
    for (const c of checked) {
      const shared = [...c.entry.shas].filter((sha) => claimed.has(sha)).length;
      if (shared > c.entry.shas.size / 2) continue;
      for (const sha of c.entry.shas) claimed.add(sha);
      addRepo(c.full, "commits");
    }
  }

  return { user, lower, repos: [...repos.values()] };
}

// ---------- merged pull requests ----------

// A merged PR's file list comes with each file's line counts and no patch
// text, 50 PRs to a request, where reading the same commits one by one takes
// a request each and carries every patch.
const PR_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        additions
        deletions
        mergeCommit { oid additions deletions }
        files(first: 100) { totalCount nodes { path additions deletions } }
      }
    }
  }
}`;

/** A commit message that ends like a squash-merged PR's: "Fix the thing (#123)". */
export const SQUASH_MESSAGE = /\(#\d+\)\s*$/;

/**
 * True when a PR's files are exactly its merge commit's files: the merge
 * commit is the squashed PR (same added and deleted totals) and the file list
 * is complete. Anything else (a rebase of several commits, a merge commit, a
 * PR of more than 100 files) is read commit by commit instead.
 */
export function prMatchesCommit(pr) {
  return Boolean(
    pr?.mergeCommit &&
      pr.files &&
      pr.files.nodes.length >= pr.files.totalCount &&
      pr.additions === pr.mergeCommit.additions &&
      pr.deletions === pr.mergeCommit.deletions,
  );
}

const day = (d) => d.toISOString().slice(0, 10);

/**
 * The user's merged PRs in one repo, by merge commit SHA. GitHub's search
 * returns at most 1,000 results per query, so a larger set is split into
 * date ranges until each fits.
 */
export async function fetchMergedPRs(client, full, login, { searchCap = 1000, onPage = () => {}, since = new Date("2008-01-01T00:00:00Z") } = {}) {
  const byCommit = new Map();
  async function range(from, to) {
    let after = null;
    let first = true;
    do {
      const q = `repo:${full} is:pr is:merged author:${login} merged:${day(from)}..${day(to)}`;
      const { search } = await client.graphql(PR_QUERY, { q, after });
      if (first && search.issueCount > searchCap && to - from > 86400000) {
        const mid = new Date(from.getTime() + Math.floor((to - from) / 2 / 86400000) * 86400000);
        await range(from, mid);
        await range(new Date(mid.getTime() + 86400000), to);
        return;
      }
      first = false;
      for (const pr of search.nodes ?? []) if (pr?.mergeCommit) byCommit.set(pr.mergeCommit.oid, pr);
      onPage(byCommit.size);
      after = search.pageInfo?.hasNextPage ? search.pageInfo.endCursor : null;
    } while (after);
  }
  await range(since, new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z"));
  return byCommit;
}

// ---------- commits ----------

/**
 * Lines added and deleted per language in one commit's file list (REST
 * `filename` or GraphQL `path`). Headers (.h) go to C or C++ by the rest of
 * the commit; see headerLanguage.
 */
export function tallyFiles(files) {
  const langs = {};
  let ignored = 0;
  const headers = [];
  const add = (lang, a, d) => {
    const row = (langs[lang] ??= [0, 0]);
    row[0] += a;
    row[1] += d;
  };
  for (const f of files ?? []) {
    const path = f.filename ?? f.path;
    const a = f.additions || 0;
    const d = f.deletions || 0;
    if (!a && !d) continue;
    const lang = languageOf(path);
    if (!lang) {
      ignored += a + d;
      continue;
    }
    if (isHeader(path)) headers.push({ a, d, patch: f.patch });
    else add(lang, a, d);
  }
  if (headers.length) {
    const lines = (lang) => (langs[lang] ? langs[lang][0] + langs[lang][1] : 0);
    const lang = headerLanguage(lines("C"), lines("C++"), headers.map((h) => h.patch));
    for (const h of headers) add(lang, h.a, h.d);
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
export async function loadProfile(
  login,
  {
    token = "",
    fetchImpl = fetch.bind(globalThis),
    signal,
    onProgress = () => {},
    onSnapshot = null,
    snapshotEvery = 5000,
    minBackoff = 60000,
    requestsPerSecond = REQUESTS_PER_SECOND,
    usePullRequests = true,
    searchCap = 1000,
    cache = memoryCache(),
  } = {},
) {
  const client = createClient({
    token,
    fetchImpl,
    signal,
    minBackoff,
    requestsPerSecond,
    onSlowDown: (until) =>
      onProgress({
        phase: "slow",
        message: `GitHub asked for a pause; carrying on at ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`,
      }),
  });
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
  let timer = null;
  const denied = [];
  const prRouteFailures = [];
  let fromPullRequests = 0;

  // Per repo: the user's commits ([sha, authored date]) and, as they load,
  // each commit's tally ({ sha: [month, { lang: [added, deleted] }, ignored] }).
  // A commit's diff is the same whoever looks at it, so diffs are cached per
  // repo, shared between users and tokens.
  const diffKey = (full) => `diffs:${full.toLowerCase()}`;
  const state = new Map();
  for (const repo of repos) {
    state.set(repo.full, {
      list: cache.get(cacheKey(`list:${repo.full.toLowerCase()}`))?.commits ?? null,
      squashed: cache.get(cacheKey(`list:${repo.full.toLowerCase()}`))?.squashed ?? 0,
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
    await pool(toList, token ? CONCURRENCY : 4, async (repo) => {
      const commits = [];
      let squashed = 0;
      for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
        const res = await request(`/repos/${repo.full}/commits?author=${encodeURIComponent(user.login)}&per_page=100&page=${page}`);
        // 403/404 on a repo we were told about: the token can see the repo
        // but not read its commits (it lacks Contents: read). Report it, and
        // don't cache it, so fixing the token's permissions takes effect.
        if (page === 1 && (res.status === 403 || res.status === 404)) {
          denied.push(repo.full);
          state.get(repo.full).list = [];
          listed++;
          listProgress();
          return;
        }
        // 409: an empty repository.
        const items = Array.isArray(res.data) ? res.data : [];
        for (const c of items) {
          if ((c.parents?.length ?? 0) > 1) continue; // merge commit
          commits.push([c.sha, c.commit?.author?.date ?? c.commit?.committer?.date]);
          if (SQUASH_MESSAGE.test((c.commit?.message ?? "").split("\n")[0])) squashed++;
        }
        if (items.length < 100) break;
      }
      state.get(repo.full).list = commits;
      state.get(repo.full).squashed = squashed;
      cache.set(cacheKey(`list:${repo.full.toLowerCase()}`), { commits, squashed });
      listed++;
      listProgress();
    });

    // 2. In PR-based repos (most of the user's commits are squash-merged
    // PRs), read their merged PRs' file lists in bulk. Needs a token, since
    // GitHub's GraphQL API always does. A repo where that fails is simply read
    // commit by commit below.
    if (token && usePullRequests) {
      for (const repo of repos) {
        const st = state.get(repo.full);
        const missing = st.list.filter(([sha]) => !st.diffs[sha]);
        if (missing.length < 5 || st.squashed < Math.max(5, st.list.length * 0.3)) continue;
        onProgress({ phase: "prs", message: `Reading merged pull requests in ${repo.full}…` });
        let prs;
        try {
          prs = await fetchMergedPRs(client, repo.full, user.login, {
            searchCap,
            onPage: (n) => onProgress({ phase: "prs", message: `Reading merged pull requests in ${repo.full}: ${n.toLocaleString()}` }),
          });
        } catch (err) {
          if (err instanceof UserError || signal?.aborted) throw err;
          prRouteFailures.push(repo.full);
          continue;
        }
        for (const [sha, date] of missing) {
          const pr = prs.get(sha);
          if (!prMatchesCommit(pr)) continue;
          const { langs, ignored } = tallyFiles(pr.files.nodes);
          st.diffs[sha] = [monthKey(date), langs, ignored];
          st.dirty = true;
          fromPullRequests++;
        }
        saveDiffs(repo.full);
      }
    }

    // 3. Each remaining commit's diff, once per commit even if it is in several repos.
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
    if (onSnapshot && done > 0) onSnapshot(snapshot());
    timer = onSnapshot ? setInterval(() => onSnapshot(snapshot()), snapshotEvery) : null;
    await pool(shuffled(todo, (t) => t.sha), token ? CONCURRENCY : 4, async ({ repo, sha, date }) => {
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
    clearInterval(timer);
    for (const repo of repos) saveDiffs(repo.full);
  }
  return snapshot();

  /**
   * Everything loaded so far: per-repo month tallies ({ month: { lang:
   * [added, deleted, commits] } }), each commit counted in the first repo that
   * has it, plus the languages of each loaded commit.
   */
  function snapshot() {
  const counted = new Set();
  const commitLangs = [];
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
      const names = Object.keys(langs);
      if (names.length) commitLangs.push(names);
      for (const [lang, [a, d]] of Object.entries(langs)) {
        const row = ((months[month] ??= {})[lang] ??= [0, 0, 0]);
        row[0] += a;
        row[1] += d;
        row[2] += 1;
        adds += a;
        dels += d;
      }
    }
    totalCommits += commits;
    loadedCommits += loaded;
    if (commits) out.push({ full: repo.full, source: repo.source, commits, loaded, adds, dels, months });
  }
  const listedRepos = repos.filter((repo) => state.get(repo.full).list).length;
  const privateRepos = repos.filter((repo) => repo.source === "private").length;
  return {
    user,
    repos: out,
    commitLangs,
    listedRepos,
    totalRepos: repos.length,
    totalCommits,
    loadedCommits,
    ignored,
    rateLimited,
    rate,
    denied: [...denied],
    fromPullRequests,
    prRouteFailures: [...prRouteFailures],
    privateRepos,
    usedToken: Boolean(token),
  };
  }
}

// ---------- aggregation ----------

/**
 * Turns per-repo month tallies into per-language monthly arrays.
 * Returns { months: ["YYYY-MM", ...], languages: [{ name, adds, dels, total, commits }] }
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
      for (const [name, [a, d, c = 0]] of Object.entries(langs)) {
        let lang = byName.get(name);
        if (!lang) {
          lang = { name, adds: new Float64Array(months.length), dels: new Float64Array(months.length), total: 0, commits: 0 };
          byName.set(name, lang);
        }
        lang.adds[i] += a;
        lang.dels[i] += d;
        lang.total += a + d;
        lang.commits += c;
      }
    }
  }
  const languages = [...byName.values()].filter((l) => l.total > 0).sort((a, b) => b.total - a.total);
  return { months, languages };
}
