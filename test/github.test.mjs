import assert from "node:assert/strict";
import { test } from "node:test";
import { addWeek, aggregate, contributorMonths, loadProfile, memoryCache, monthRange } from "../public/js/github.js";
import { createFakeGitHub } from "./fixture.mjs";

test("monthRange spans years", () => {
  assert.deepEqual(monthRange("2019-11", "2020-02"), ["2019-11", "2019-12", "2020-01", "2020-02"]);
});

test("a week straddling two months is split by day", () => {
  const months = {};
  // Sunday 2024-03-31: one day in March, six in April.
  addWeek(months, Date.UTC(2024, 2, 31) / 1000, 70, 7, 7);
  assert.equal(months["2024-03"][0], 10);
  assert.equal(months["2024-04"][0], 60);
  assert.equal(months["2024-04"][1], 6);
});

test("contributorMonths matches the login case-insensitively", () => {
  const r = contributorMonths([{ author: { login: "Someone" }, weeks: [{ w: Date.UTC(2024, 0, 7) / 1000, a: 7, d: 14, c: 1 }] }], "someone");
  assert.equal(r.adds, 7);
  assert.equal(r.dels, 14);
  assert.ok(Math.abs(r.months["2024-01"][0] - 7) < 1e-9);
});

test("loadProfile finds the right repos and splits lines by language", async () => {
  const gh = createFakeGitHub();
  const profile = await loadProfile("octo-dev", { fetchImpl: gh.fetchImpl, cache: memoryCache() });
  const names = profile.repos.map((r) => r.full).sort();
  assert.deepEqual(names, ["acme/infra", "big/huge", "friend/lib", "octo-dev/cli", "octo-dev/legacy-js", "octo-dev/ml", "octo-dev/webapp"]);
  assert.equal(profile.rateLimited, null);
  assert.deepEqual(profile.computing, []);

  // The big repo has no line counts in its stats, so its merged PRs are used.
  const huge = profile.repos.find((r) => r.full === "big/huge");
  assert.equal(huge.method, "prs");
  assert.equal(huge.adds, 6000);
  assert.equal(huge.dels, 3700);

  const data = aggregate(profile, Date.UTC(2026, 10, 10));
  assert.equal(data.months[0], "2016-04");
  assert.equal(data.months.at(-1), "2026-11");
  const total = (name) => data.languages.find((l) => l.name === name)?.total ?? 0;
  // C++ gets 900/920 of the big repo's lines.
  assert.ok(Math.abs(total("C++") - (9700 * 900000) / 920000) < 1e-6);
  // Lines are conserved by the language split.
  const sumRepos = profile.repos.reduce((s, r) => s + r.adds + r.dels, 0);
  const sumLangs = data.languages.reduce((s, l) => s + l.total, 0);
  assert.ok(Math.abs(sumRepos - sumLangs) < 1e-6 * sumRepos);
});

test("a rate limit returns what loaded, and the cache resumes from there", async () => {
  const cache = memoryCache();
  const first = await loadProfile("octo-dev", { fetchImpl: createFakeGitHub({ computingOnce: [], rateLimitAfter: 9 }).fetchImpl, cache });
  assert.ok(first.rateLimited);
  assert.ok(first.scanned < first.total);
  const gh = createFakeGitHub({ computingOnce: [] });
  const second = await loadProfile("octo-dev", { fetchImpl: gh.fetchImpl, cache });
  assert.equal(second.rateLimited, null);
  assert.equal(second.scanned, second.total);
  assert.equal(second.repos.length, 7);
});

test("unknown users and organizations get a clear error", async () => {
  const gh = createFakeGitHub();
  await assert.rejects(loadProfile("nobody-here", { fetchImpl: gh.fetchImpl }), /no GitHub user/);
});
