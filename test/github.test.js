import assert from "node:assert/strict";
import { test } from "bun:test";
import { aggregate, createPacer, loadProfile, memoryCache, monthRange, prMatchesCommit, tallyFiles } from "../public/js/github.js";
import { languageOf } from "../public/js/languages.js";
import { createFakeGitHub, FIXTURE } from "./fixture.mjs";

test("monthRange spans years", () => {
  assert.deepEqual(monthRange("2019-11", "2020-02"), ["2019-11", "2019-12", "2020-01", "2020-02"]);
});

test("files map to languages by extension or name", () => {
  const cases = {
    "src/app.py": "Python",
    "web/main.ts": "JS/TS",
    "web/View.tsx": "JS/TS",
    "lib/index.js": "JS/TS",
    "src/routes/+page.svelte": "JS/TS",
    "components/Card.vue": "JS/TS",
    "src/pages/index.astro": "JS/TS",
    "src/core.cpp": "C++",
    "include/core.hpp": "C++",
    "src/lib.c": "C",
    "src/main.rs": "Rust",
    "cmd/server.go": "Go",
    "Makefile": "Makefile",
    "build/Dockerfile.dev": null, // under build/: generated output
    "docker/Dockerfile": "Dockerfile",
    "CMakeLists.txt": "CMake",
    "notebooks/a.ipynb": "Jupyter Notebook",
    "styles/site.scss": "CSS",
    "styles/theme.sass": "CSS",
    "styles/vars.less": "CSS",
    "styles/app.styl": "CSS",
    "styles/main.pcss": "CSS",
    "infra/main.tf": "HCL",
    "Gemfile": "Ruby",
  };
  for (const [path, lang] of Object.entries(cases)) assert.equal(languageOf(path), lang, path);
});

test("data, prose, lockfiles and vendored or generated files are not counted", () => {
  for (const path of [
    "package.json",
    "config.yaml",
    "README.md",
    "notes.txt",
    "package-lock.json",
    "Cargo.lock",
    "go.sum",
    "logo.png",
    "public/app.min.js",
    "node_modules/left-pad/index.js",
    "vendor/github.com/x/y.go",
    "dist/index.js",
    "api/service_pb2.py",
    "LICENSE",
  ]) {
    assert.equal(languageOf(path), null, path);
  }
});

test("names of built-in object properties are not languages", () => {
  for (const path of ["src/x.constructor", "constructor", "a/toString", "b.hasOwnProperty", "c.__proto__", "valueOf"]) {
    assert.equal(languageOf(path), null, path);
  }
});

test(".h headers follow the rest of their commit", () => {
  const cpp = tallyFiles([{ filename: "a.cpp", additions: 10, deletions: 0 }, { filename: "a.h", additions: 4, deletions: 1 }]);
  assert.deepEqual(cpp.langs, { "C++": [14, 1] });
  const c = tallyFiles([{ filename: "a.c", additions: 10, deletions: 0 }, { filename: "a.h", additions: 4, deletions: 1 }]);
  assert.deepEqual(c.langs, { C: [14, 1] });
  const cppOnly = tallyFiles([{ filename: "a.h", additions: 3, deletions: 0, patch: "+namespace JSC {\n+class Walk;\n+}" }]);
  assert.deepEqual(cppOnly.langs, { "C++": [3, 0] });
  const cOnly = tallyFiles([{ filename: "a.h", additions: 2, deletions: 0, patch: "+int f(void);\n+#define X 1" }]);
  assert.deepEqual(cOnly.langs, { C: [2, 0] });
  // GraphQL file lists say `path`, not `filename`.
  assert.deepEqual(tallyFiles([{ path: "x.py", additions: 1, deletions: 0 }]).langs, { Python: [1, 0] });
});

test("tallyFiles adds up lines per language and reports what it skipped", () => {
  const { langs, ignored } = tallyFiles([
    { filename: "a.py", additions: 10, deletions: 2 },
    { filename: "b.py", additions: 5, deletions: 1 },
    { filename: "c.js", additions: 3, deletions: 0 },
    { filename: "package-lock.json", additions: 900, deletions: 800 },
  ]);
  assert.deepEqual(langs, { Python: [15, 3], "JS/TS": [3, 0] });
  assert.equal(ignored, 1700);
});

/** What the pipeline should find, worked out straight from the fixture. */
function expected({ withPrivate }) {
  const counted = ["octo-dev/webapp", "octo-dev/legacy-js", "octo-dev/ml", "octo-dev/cli", "acme/infra", "big/huge", "friend/lib"];
  if (withPrivate) counted.push("octo-dev/secret");
  const seen = new Set();
  const langs = {};
  let commits = 0;
  for (const full of counted) {
    for (const c of FIXTURE.repos[full].commits) {
      if (c.parents > 1 || seen.has(c.sha)) continue;
      seen.add(c.sha);
      commits++;
      for (const f of c.files) {
        const lang = languageOf(f.filename);
        if (!lang) continue;
        langs[lang] = (langs[lang] ?? 0) + f.additions + f.deletions;
      }
    }
  }
  return { repos: counted.sort(), commits, langs };
}

test("loadProfile reads every accepted commit's diff, once", async () => {
  const gh = createFakeGitHub();
  const profile = await loadProfile("octo-dev", { requestsPerSecond: Infinity, fetchImpl: gh.fetchImpl, cache: memoryCache() });
  const want = expected({ withPrivate: false });
  assert.equal(profile.rateLimited, null);
  assert.deepEqual(profile.repos.map((r) => r.full).sort(), want.repos);
  assert.equal(profile.totalCommits, want.commits);
  assert.equal(profile.loadedCommits, want.commits);

  const data = aggregate(profile, Date.UTC(2026, 10, 10));
  assert.equal(data.months[0], "2016-04");
  assert.equal(data.months.at(-1), "2026-11");
  const got = Object.fromEntries(data.languages.map((l) => [l.name, l.total]));
  assert.deepEqual(got, want.langs);
  // The 450-file commit was read past its first page of files.
  assert.ok(got.Rust >= 450 * 12);
  // Nothing from merge commits, lockfiles, Markdown, YAML or vendored files.
  assert.ok(profile.ignored > 0);
  for (const name of ["JSON", "YAML", "Markdown"]) assert.equal(got[name], undefined);
});

test("with a token, private repos the token can read are included", async () => {
  const gh = createFakeGitHub();
  const profile = await loadProfile("octo-dev", { requestsPerSecond: Infinity, token: "github_pat_test", fetchImpl: gh.fetchImpl, cache: memoryCache() });
  const want = expected({ withPrivate: true });
  assert.deepEqual(profile.repos.map((r) => r.full).sort(), want.repos);
  assert.equal(profile.repos.find((r) => r.full === "octo-dev/secret").source, "private");
  const data = aggregate(profile);
  assert.ok(data.languages.some((l) => l.name === "Go"));
});

test("a token that can't read commits is reported, and not cached as empty", async () => {
  const cache = memoryCache();
  const token = "github_pat_test";
  const first = await loadProfile("octo-dev", { requestsPerSecond: Infinity, token, fetchImpl: createFakeGitHub({ tokenAccess: "no-contents" }).fetchImpl, cache });
  assert.deepEqual(first.denied, ["octo-dev/secret"]);
  assert.equal(first.privateRepos, 1);
  assert.equal(first.repos.find((r) => r.full === "octo-dev/secret"), undefined);
  // The same token after its permissions are fixed on GitHub.
  const second = await loadProfile("octo-dev", { requestsPerSecond: Infinity, token, fetchImpl: createFakeGitHub().fetchImpl, cache });
  assert.deepEqual(second.denied, []);
  assert.ok(second.repos.find((r) => r.full === "octo-dev/secret"));
});

test("a token that sees no private repos says so", async () => {
  const profile = await loadProfile("octo-dev", { requestsPerSecond: Infinity, token: "github_pat_test", fetchImpl: createFakeGitHub({ tokenAccess: "public-only" }).fetchImpl, cache: memoryCache() });
  assert.equal(profile.usedToken, true);
  assert.equal(profile.privateRepos, 0);
});

test("clearing cached lists keeps diffs, so a token change re-discovers repos cheaply", async () => {
  const cache = memoryCache();
  const token = "github_pat_test";
  await loadProfile("octo-dev", { requestsPerSecond: Infinity, token, fetchImpl: createFakeGitHub({ tokenAccess: "public-only" }).fetchImpl, cache });
  cache.clearLists();
  const gh = createFakeGitHub();
  const after = await loadProfile("octo-dev", { requestsPerSecond: Infinity, token, fetchImpl: gh.fetchImpl, cache });
  assert.equal(after.privateRepos, 1);
  assert.ok(after.repos.find((r) => r.full === "octo-dev/secret"));
  // Diffs read before were reused: only the private repo's commits (plus lists) were fetched.
  const secretCommits = after.repos.find((r) => r.full === "octo-dev/secret").commits;
  assert.ok(gh.calls() < secretCommits + 40, `${gh.calls()} calls`);
});

test("a rate limit returns an even sample, and the cache resumes from there", async () => {
  const cache = memoryCache();
  const first = await loadProfile("octo-dev", { requestsPerSecond: Infinity, fetchImpl: createFakeGitHub({ rateLimitAfter: 200 }).fetchImpl, cache });
  assert.ok(first.rateLimited);
  assert.ok(first.loadedCommits > 0 && first.loadedCommits < first.totalCommits);
  // Shuffled order: the partial sample spans the whole history, not just one end.
  const years = new Set(first.repos.flatMap((r) => Object.keys(r.months).map((k) => k.slice(0, 4))));
  assert.ok(years.size >= 8, `sample covers ${years.size} years`);

  const gh = createFakeGitHub();
  const second = await loadProfile("octo-dev", { requestsPerSecond: Infinity, fetchImpl: gh.fetchImpl, cache });
  assert.equal(second.rateLimited, null);
  assert.equal(second.loadedCommits, second.totalCommits);
  // Only the commits not read the first time were fetched.
  assert.ok(gh.calls() < second.totalCommits - first.loadedCommits + 60, `${gh.calls()} calls`);
});

test("requests are paced: a burst, then a steady rate", async () => {
  const pacer = createPacer(40, 10);
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) await pacer.take();
  const secs = (Date.now() - t0) / 1000;
  // 10 straight away, then 20 more at 40 a second: about half a second.
  assert.ok(secs > 0.4 && secs < 0.9, `${secs}s`);
});

test("a 'slow down' answer pauses everything, then the load carries on", async () => {
  const phases = [];
  const gh = createFakeGitHub({ slowDownAt: 40 });
  const t0 = Date.now();
  const profile = await loadProfile("octo-dev", {
    requestsPerSecond: Infinity,
    minBackoff: 10,
    fetchImpl: gh.fetchImpl,
    cache: memoryCache(),
    onProgress: (p) => phases.push(p.phase),
  });
  assert.ok(phases.includes("slow"));
  assert.ok(Date.now() - t0 >= 1000, "waited for Retry-After");
  assert.equal(profile.rateLimited, null);
  assert.equal(profile.loadedCommits, profile.totalCommits);
});

test("snapshots arrive while loading, growing, and the last matches the result", async () => {
  const snaps = [];
  const profile = await loadProfile("octo-dev", {
    requestsPerSecond: 2000,
    snapshotEvery: 100,
    fetchImpl: createFakeGitHub().fetchImpl,
    cache: memoryCache(),
    onSnapshot: (p) => snaps.push(p.loadedCommits),
  });
  assert.ok(snaps.length >= 3, `${snaps.length} snapshots`);
  for (let i = 1; i < snaps.length; i++) assert.ok(snaps[i] >= snaps[i - 1]);
  assert.ok(snaps[0] < profile.loadedCommits);
});

test("a failure while showing a snapshot doesn't stop the load", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const profile = await loadProfile("octo-dev", {
      requestsPerSecond: 2000,
      snapshotEvery: 50,
      fetchImpl: createFakeGitHub().fetchImpl,
      cache: memoryCache(),
      onSnapshot: () => {
        throw new Error("drawing failed");
      },
    });
    assert.equal(profile.loadedCommits, profile.totalCommits);
  } finally {
    console.error = original;
  }
});

test("each language knows how many commits touched it", async () => {
  const profile = await loadProfile("octo-dev", { requestsPerSecond: Infinity, fetchImpl: createFakeGitHub().fetchImpl, cache: memoryCache() });
  const data = aggregate(profile);
  for (const lang of data.languages) {
    const touching = profile.commitLangs.filter((names) => names.includes(lang.name)).length;
    assert.equal(lang.commits, touching, lang.name);
  }
  assert.equal(profile.commitLangs.length <= profile.loadedCommits, true);
});

test("PR-based repos are read from merged PRs, falling back where a PR doesn't match its commit", async () => {
  const gh = createFakeGitHub();
  const profile = await loadProfile("octo-dev", { token: "github_pat_test", requestsPerSecond: Infinity, fetchImpl: gh.fetchImpl, cache: memoryCache() });
  const prs = gh.prsOf("octo-dev/ml");
  const usable = prs.filter(prMatchesCommit).length;
  assert.ok(usable > 100 && usable < prs.length, `${usable} of ${prs.length} PRs usable`);
  assert.equal(profile.fromPullRequests, usable);
  // Only the commits whose PRs couldn't be trusted were read one by one.
  assert.equal(gh.detailCalls()["octo-dev/ml"], prs.length - usable);
  assert.ok(gh.graphqlCalls() >= Math.ceil(prs.length / 50));
  // And the numbers are exactly what reading every commit gives.
  const want = expected({ withPrivate: true });
  const got = Object.fromEntries(aggregate(profile).languages.map((l) => [l.name, l.total]));
  assert.deepEqual(got, want.langs);
});

test("without a token, or in repos that aren't PR-based, commits are read one by one", async () => {
  const gh = createFakeGitHub();
  await loadProfile("octo-dev", { requestsPerSecond: Infinity, fetchImpl: gh.fetchImpl, cache: memoryCache() });
  assert.equal(gh.graphqlCalls(), 0);
  const gh2 = createFakeGitHub();
  await loadProfile("octo-dev", { token: "github_pat_test", requestsPerSecond: Infinity, fetchImpl: gh2.fetchImpl, cache: memoryCache() });
  // webapp's commits aren't squash-merged PRs, so GraphQL is never asked about it.
  assert.ok(gh2.detailCalls()["octo-dev/webapp"] > 300);
});

test("more merged PRs than one search returns are fetched in date ranges", async () => {
  const gh = createFakeGitHub();
  const profile = await loadProfile("octo-dev", { token: "github_pat_test", requestsPerSecond: Infinity, searchCap: 60, fetchImpl: gh.fetchImpl, cache: memoryCache() });
  const usable = gh.prsOf("octo-dev/ml").filter(prMatchesCommit).length;
  assert.equal(profile.fromPullRequests, usable);
  const got = Object.fromEntries(aggregate(profile).languages.map((l) => [l.name, l.total]));
  assert.deepEqual(got, expected({ withPrivate: true }).langs);
});

test("unknown users get a clear error", async () => {
  const gh = createFakeGitHub();
  await assert.rejects(loadProfile("nobody-here", { requestsPerSecond: Infinity, fetchImpl: gh.fetchImpl }), /no GitHub user/);
});
