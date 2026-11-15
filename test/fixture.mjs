// A fake GitHub API for tests and local screenshots: one user, "octo-dev",
// with own repos, a fork, a member repo, a big repo reached through merged
// pull requests, a repo found by commit search, and a later copy of that repo
// that must not be counted twice.

const DAY = 86400;
const created = Date.UTC(2016, 3, 12) / 1000;
const now = Date.UTC(2026, 10, 10) / 1000;

function weeks(fn) {
  const out = [];
  const start = created - ((new Date(created * 1000).getUTCDay() * DAY) % (7 * DAY));
  for (let w = start; w < now; w += 7 * DAY) {
    const t = (w - created) / (now - created); // 0..1 over the account's life
    const [a, d, c] = fn(t, w);
    out.push({ w, a: Math.max(0, Math.round(a)), d: Math.max(0, Math.round(d)), c: Math.max(0, Math.round(c)) });
  }
  return out;
}
const wave = (t, k) => 0.5 + 0.5 * Math.sin(t * k);
const between = (t, a, b) => (t >= a && t <= b ? 1 : 0);

const repos = {
  "octo-dev/webapp": {
    owner: "octo-dev",
    created_at: "2016-05-01T00:00:00Z",
    language: "TypeScript",
    languages: { TypeScript: 70000, CSS: 18000, HTML: 9000, JavaScript: 3000 },
    weeks: weeks((t) => [between(t, 0.1, 0.8) * 900 * wave(t, 20), between(t, 0.1, 0.8) * 400 * wave(t, 17), 6]),
  },
  "octo-dev/legacy-js": {
    owner: "octo-dev",
    created_at: "2016-04-20T00:00:00Z",
    language: "JavaScript",
    languages: { JavaScript: 50000, HTML: 5000 },
    weeks: weeks((t) => [between(t, 0, 0.35) * 1200 * wave(t, 30), between(t, 0, 0.45) * 500, 4]),
  },
  "octo-dev/ml": {
    owner: "octo-dev",
    created_at: "2019-01-01T00:00:00Z",
    language: "Python",
    languages: { Python: 80000, "Jupyter Notebook": 20000 },
    weeks: weeks((t) => [between(t, 0.3, 1) * 1500 * t, between(t, 0.3, 1) * 600 * t, 8]),
  },
  "octo-dev/cli": {
    owner: "octo-dev",
    created_at: "2021-06-01T00:00:00Z",
    language: "Rust",
    languages: { Rust: 40000, Shell: 2000 },
    weeks: weeks((t) => [between(t, 0.55, 1) * 1100 * wave(t, 9), between(t, 0.55, 1) * 700 * wave(t, 11), 5]),
  },
  // Private: only listed (and readable) with a token.
  "octo-dev/secret": {
    owner: "octo-dev",
    private: true,
    created_at: "2023-01-01T00:00:00Z",
    language: "Go",
    languages: { Go: 30000 },
    weeks: weeks((t) => [between(t, 0.7, 1) * 800, between(t, 0.7, 1) * 200, 4]),
  },
  "octo-dev/somefork": { owner: "octo-dev", fork: true, created_at: "2020-01-01T00:00:00Z", language: "C", languages: { C: 1 }, weeks: [] },
  "acme/infra": {
    owner: "acme",
    member: true,
    created_at: "2015-01-01T00:00:00Z",
    language: "HCL",
    languages: { HCL: 30000, Shell: 6000, Go: 10000 },
    weeks: weeks((t) => [between(t, 0.4, 0.9) * 500, between(t, 0.4, 0.9) * 300, 2]),
  },
  "big/huge": {
    owner: "big",
    created_at: "2010-01-01T00:00:00Z",
    language: "C++",
    languages: { "C++": 900000, CMake: 20000 },
    // 10,000+ commits: GitHub reports commits but no line counts.
    weeks: weeks((t) => [0, 0, between(t, 0.2, 0.6) * 1]),
    prs: [
      { number: 101, merged_at: "2018-03-14T10:00:00Z", additions: 1200, deletions: 300, commits: 3 },
      { number: 202, merged_at: "2019-07-02T10:00:00Z", additions: 4000, deletions: 2500, commits: 9 },
      { number: 303, merged_at: "2020-11-20T10:00:00Z", additions: 800, deletions: 900, commits: 2 },
    ],
  },
  "friend/lib": {
    owner: "friend",
    created_at: "2017-01-01T00:00:00Z",
    language: "C",
    languages: { C: 25000, Makefile: 1000 },
    weeks: weeks((t) => [between(t, 0.15, 0.3) * 700, between(t, 0.15, 0.3) * 200, 3]),
    shas: ["aaa1", "aaa2", "aaa3"],
    firstCommit: "2017-10-01T00:00:00Z",
  },
  // A re-upload of friend/lib made later: same commits, must be skipped.
  "copycat/lib-copy": {
    owner: "copycat",
    created_at: "2024-02-01T00:00:00Z",
    language: "C",
    languages: { C: 25000 },
    weeks: [],
    shas: ["aaa1", "aaa2", "aaa3"],
    firstCommit: "2017-10-01T00:00:00Z",
  },
};

export function createFakeGitHub({ computingOnce = ["octo-dev/ml"], rateLimitAfter = Infinity } = {}) {
  const asked = new Set();
  let calls = 0;
  const json = (body, status = 200, extra = {}) => ({
    status,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(now + 3600), ...extra },
    body: body === null ? "" : JSON.stringify(body),
  });
  const repoJson = (full) => {
    const r = repos[full];
    return { full_name: full, fork: Boolean(r.fork), size: 100, language: r.language, created_at: r.created_at, html_url: `https://github.com/${full}` };
  };

  function handle(href, headers = {}) {
    const url = new URL(href);
    const authed = Boolean(headers.Authorization || headers.authorization);
    const path = url.pathname;
    calls++;
    if (calls > rateLimitAfter && !path.startsWith("/search/")) {
      return json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" });
    }
    let m;
    if ((m = path.match(/^\/users\/([^/]+)$/))) {
      if (m[1].toLowerCase() !== "octo-dev") return json({ message: "Not Found" }, 404);
      return json({ login: "octo-dev", name: "Octo Dev", type: "User", avatar_url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect width='1' height='1' fill='%23399e50'/%3E%3C/svg%3E", html_url: "https://github.com/octo-dev", created_at: new Date(created * 1000).toISOString() });
    }
    if ((m = path.match(/^\/users\/([^/]+)\/repos$/))) {
      const type = url.searchParams.get("type");
      const list = Object.keys(repos).filter((full) => !repos[full].private && (type === "owner" ? repos[full].owner === "octo-dev" : repos[full].member));
      return json(url.searchParams.get("page") === "1" ? list.map(repoJson) : []);
    }
    if (path === "/user/repos") {
      if (!authed) return json({ message: "Requires authentication" }, 401);
      const list = Object.keys(repos).filter((full) => repos[full].private);
      return json(url.searchParams.get("page") === "1" ? list.map(repoJson) : []);
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)/)) && repos[m[1]]?.private && !authed) return json({ message: "Not Found" }, 404);
    if (path === "/search/issues") {
      const items = [];
      for (const [full, r] of Object.entries(repos)) for (const pr of r.prs ?? []) items.push({ number: pr.number, repository_url: `https://api.github.com/repos/${full}`, pull_request: { merged_at: pr.merged_at } });
      return json({ total_count: items.length, items }, 200, { "x-ratelimit-resource": "search" });
    }
    if (path === "/search/commits") {
      const items = [];
      for (const [full, r] of Object.entries(repos)) {
        for (const sha of r.shas ?? []) items.push({ sha, repository: { full_name: full, fork: false }, commit: { author: { date: r.firstCommit } } });
      }
      return json({ total_count: items.length, items }, 200, { "x-ratelimit-resource": "search" });
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/stats\/contributors$/))) {
      if (computingOnce.includes(m[1]) && !asked.has(m[1])) {
        asked.add(m[1]);
        return json({}, 202);
      }
      const r = repos[m[1]];
      return json([{ author: { login: "someone-else" }, weeks: [] }, { author: { login: "Octo-Dev" }, total: 1, weeks: r.weeks }]);
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/languages$/))) return json(repos[m[1]].languages);
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/))) {
      const pr = repos[m[1]].prs.find((p) => p.number === Number(m[2]));
      return json({ number: pr.number, additions: pr.additions, deletions: pr.deletions, commits: pr.commits });
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)$/))) return repos[m[1]] ? json(repoJson(m[1])) : json({ message: "Not Found" }, 404);
    return json({ message: `Unhandled ${path}` }, 404);
  }

  const fetchImpl = async (href, init = {}) => {
    const r = handle(href, init.headers);
    return new Response(r.body || null, { status: r.status, headers: r.headers });
  };
  return { handle, fetchImpl, calls: () => calls };
}
