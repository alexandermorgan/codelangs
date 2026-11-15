// A fake GitHub API for tests and local screenshots: one user, "octo-dev",
// with own repos, a fork, a member repo, a private repo (visible only with a
// token), a repo with a merged PR, a repo found by commit search, and a later
// copy of that repo that must not be counted twice.

const DAY = 86400 * 1000;
const created = Date.UTC(2016, 3, 12);
const now = Date.UTC(2026, 10, 10);

const wave = (t, k) => 0.5 + 0.5 * Math.sin(t * k);
const between = (t, a, b) => (t >= a && t <= b ? 1 : 0);

let shaCounter = 0;
const nextSha = () => (++shaCounter).toString(16).padStart(40, "0");

/**
 * One commit a week while `size(t)` (t = 0..1 over the account's life) is
 * above zero, changing `files` ([path, share of the lines]). Every tenth
 * commit is followed by a merge commit, which must be ignored.
 */
function history(files, size, delRatio = 0.4) {
  const commits = [];
  let n = 0;
  for (let at = created + 3 * DAY; at < now; at += 7 * DAY) {
    const t = (at - created) / (now - created);
    const lines = Math.round(size(t));
    if (lines <= 0) continue;
    const changed = files.map(([filename, share]) => ({
      filename,
      additions: Math.round(lines * share),
      deletions: Math.round(lines * share * delRatio),
    }));
    commits.push({ sha: nextSha(), date: new Date(at).toISOString(), parents: 1, files: changed });
    if (++n % 10 === 0) {
      commits.push({ sha: nextSha(), date: new Date(at + DAY).toISOString(), parents: 2, files: [{ filename: "src/huge.py", additions: 99999, deletions: 0 }] });
    }
  }
  return commits;
}

const repos = {
  "octo-dev/webapp": {
    owner: "octo-dev",
    created_at: "2016-05-01T00:00:00Z",
    commits: history(
      [["src/app.ts", 0.55], ["src/view.tsx", 0.15], ["src/style.scss", 0.15], ["index.html", 0.05], ["package-lock.json", 0.05], ["README.md", 0.05]],
      (t) => between(t, 0.1, 0.8) * 1300 * wave(t, 20),
    ),
  },
  "octo-dev/legacy-js": {
    owner: "octo-dev",
    created_at: "2016-04-20T00:00:00Z",
    commits: history(
      [["lib/index.js", 0.8], ["public/app.min.js", 0.1], ["node_modules/x/y.js", 0.05], ["index.html", 0.05]],
      (t) => between(t, 0, 0.35) * 1200 * wave(t, 30),
      0.5,
    ),
  },
  "octo-dev/ml": {
    owner: "octo-dev",
    created_at: "2019-01-01T00:00:00Z",
    commits: history([["model/train.py", 0.7], ["notebooks/explore.ipynb", 0.2], ["config.yaml", 0.1]], (t) => between(t, 0.3, 1) * 2000 * t),
  },
  "octo-dev/cli": {
    owner: "octo-dev",
    created_at: "2021-06-01T00:00:00Z",
    commits: [
      ...history([["src/main.rs", 0.8], ["Cargo.lock", 0.1], ["scripts/release.sh", 0.1]], (t) => between(t, 0.55, 1) * 1600 * wave(t, 9)),
      // One big commit: 450 files, listed over two pages.
      {
        sha: "b".repeat(40),
        date: "2023-05-17T12:00:00Z",
        parents: 1,
        files: Array.from({ length: 450 }, (_, i) => ({ filename: `src/gen/mod${i}.rs`, additions: 10, deletions: 2 })),
      },
    ],
  },
  "octo-dev/secret": {
    owner: "octo-dev",
    private: true,
    created_at: "2023-01-01T00:00:00Z",
    commits: history([["cmd/server.go", 0.9], ["go.sum", 0.1]], (t) => between(t, 0.7, 1) * 1000),
  },
  "octo-dev/somefork": { owner: "octo-dev", fork: true, created_at: "2020-01-01T00:00:00Z", commits: [] },
  "acme/infra": {
    owner: "acme",
    member: true,
    created_at: "2015-01-01T00:00:00Z",
    commits: history([["main.tf", 0.6], ["scripts/deploy.sh", 0.2], ["Dockerfile", 0.2]], (t) => between(t, 0.4, 0.9) * 800),
  },
  "big/huge": {
    owner: "big",
    created_at: "2010-01-01T00:00:00Z",
    prs: [101],
    commits: [
      { sha: nextSha(), date: "2018-03-14T10:00:00Z", parents: 1, files: [{ filename: "src/core.cpp", additions: 1200, deletions: 300 }, { filename: "CMakeLists.txt", additions: 10, deletions: 2 }] },
      { sha: nextSha(), date: "2019-07-02T10:00:00Z", parents: 1, files: [{ filename: "include/core.hpp", additions: 4000, deletions: 2500 }] },
    ],
  },
  "friend/lib": {
    owner: "friend",
    created_at: "2017-01-01T00:00:00Z",
    commits: history([["src/lib.c", 0.7], ["src/lib.h", 0.2], ["Makefile", 0.1]], (t) => between(t, 0.15, 0.3) * 900),
    searchable: true,
  },
};
// A re-upload of friend/lib made later, with the same commits: must not count.
repos["copycat/lib-copy"] = { owner: "copycat", created_at: "2024-02-01T00:00:00Z", commits: repos["friend/lib"].commits, searchable: true };
// The member repo also contains one of webapp's commits: it must count once.
repos["acme/infra"].commits.push(repos["octo-dev/webapp"].commits[0]);

export const FIXTURE = { repos };

export function createFakeGitHub({ rateLimitAfter = Infinity } = {}) {
  let calls = 0;
  const json = (body, status = 200, extra = {}) => ({
    status,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": String(Math.round(now / 1000) + 3600),
      ...extra,
    },
    body: body === null ? "" : JSON.stringify(body),
  });
  const repoJson = (full) => {
    const r = repos[full];
    return { full_name: full, fork: Boolean(r.fork), private: Boolean(r.private), size: 100, created_at: r.created_at };
  };

  function handle(href, headers = {}) {
    const url = new URL(href);
    const path = url.pathname;
    const page = Number(url.searchParams.get("page") || 1);
    const authed = Boolean(headers.Authorization || headers.authorization);
    calls++;
    if (calls > rateLimitAfter && !path.startsWith("/search/")) {
      return json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" });
    }
    let m;
    if ((m = path.match(/^\/users\/([^/]+)$/))) {
      if (m[1].toLowerCase() !== "octo-dev") return json({ message: "Not Found" }, 404);
      return json({
        login: "octo-dev",
        name: "Octo Dev",
        type: "User",
        avatar_url: "https://avatars.example/octo-dev.png",
        html_url: "https://github.com/octo-dev",
        created_at: new Date(created).toISOString(),
      });
    }
    if ((m = path.match(/^\/users\/([^/]+)\/repos$/))) {
      const type = url.searchParams.get("type");
      const list = Object.keys(repos).filter((full) => !repos[full].private && (type === "owner" ? repos[full].owner === "octo-dev" : repos[full].member));
      return json(page === 1 ? list.map(repoJson) : []);
    }
    if (path === "/user/repos") {
      if (!authed) return json({ message: "Requires authentication" }, 401);
      return json(page === 1 ? Object.keys(repos).filter((full) => repos[full].private).map(repoJson) : []);
    }
    if (path === "/search/issues") {
      const items = [];
      for (const [full, r] of Object.entries(repos)) for (const number of r.prs ?? []) items.push({ number, repository_url: `https://api.github.com/repos/${full}` });
      return json({ total_count: items.length, items }, 200, { "x-ratelimit-resource": "search" });
    }
    if (path === "/search/commits") {
      const items = [];
      for (const [full, r] of Object.entries(repos)) {
        if (!r.searchable) continue;
        for (const c of r.commits.slice(0, 3)) items.push({ sha: c.sha, repository: { full_name: full, fork: false }, commit: { author: { date: c.date } } });
      }
      return json({ total_count: items.length, items }, 200, { "x-ratelimit-resource": "search" });
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)/)) && (!repos[m[1]] || (repos[m[1]].private && !authed))) return json({ message: "Not Found" }, 404);
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/commits$/))) {
      if (url.searchParams.get("author")?.toLowerCase() !== "octo-dev") return json([]);
      const per = Number(url.searchParams.get("per_page") || 30);
      const list = [...repos[m[1]].commits].sort((a, b) => b.date.localeCompare(a.date));
      return json(
        list.slice((page - 1) * per, page * per).map((c) => ({
          sha: c.sha,
          parents: Array.from({ length: c.parents }, (_, i) => ({ sha: `p${i}` })),
          commit: { author: { date: c.date }, committer: { date: c.date } },
        })),
      );
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)$/))) {
      const c = repos[m[1]].commits.find((x) => x.sha === m[2]);
      if (!c) return json({ message: "No commit found" }, 422);
      const per = Number(url.searchParams.get("per_page") || 300);
      const files = c.files.slice((page - 1) * per, page * per);
      const more = page * per < c.files.length;
      return json({ sha: c.sha, files }, 200, more ? { link: `<${url.origin}${path}?per_page=${per}&page=${page + 1}>; rel="next"` } : {});
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)$/))) return json(repoJson(m[1]));
    return json({ message: `Unhandled ${path}` }, 404);
  }

  const fetchImpl = async (href, init = {}) => {
    const r = handle(href, init.headers);
    return new Response(r.body || null, { status: r.status, headers: r.headers });
  };
  return { handle, fetchImpl, calls: () => calls };
}
