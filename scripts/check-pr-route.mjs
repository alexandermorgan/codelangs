// Checks the merged-PR route against real GitHub: reads a user's recent
// commits in one repo both ways (each commit's own file list, and its merged
// PR's file list from GraphQL) and compares the language totals.
//
//   GH_TOKEN=github_pat_… bun scripts/check-pr-route.mjs <user> <owner/repo> [commits=30]
//
// The token needs Contents (read) and, for private repos, Pull requests (read).
import { createClient, fetchMergedPRs, prMatchesCommit, tallyFiles } from "../public/js/github.js";

const [login, repo, count = "30"] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
if (!login || !repo || !token) {
  console.error("Usage: GH_TOKEN=… bun scripts/check-pr-route.mjs <user> <owner/repo> [commits=30]");
  process.exit(1);
}
const client = createClient({ token, requestsPerSecond: 10 });
const res = await client.request(`/repos/${repo}/commits?author=${encodeURIComponent(login)}&per_page=100`);
if (!Array.isArray(res.data)) {
  console.error(`Couldn't list commits (HTTP ${res.status}). Check the names and the token's Contents permission.`);
  process.exit(1);
}
const commits = res.data.filter((c) => c.parents.length === 1).slice(0, Number(count));
const oldest = new Date(commits.at(-1).commit.author.date);
const since = new Date(Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth(), oldest.getUTCDate() - 1));
console.log(`${commits.length} recent commits by ${login} in ${repo}; reading their merged PRs since ${since.toISOString().slice(0, 10)}…`);
const prs = await fetchMergedPRs(client, repo, login, { since });

const fmt = (langs) => Object.entries(langs).sort().map(([l, [a, d]]) => `${l} +${a} -${d}`).join(", ") || "(no code)";
let viaPR = 0, same = 0;
const diffs = [];
for (const c of commits) {
  const pr = prs.get(c.sha);
  const usable = prMatchesCommit(pr);
  const files = [];
  for (let page = 1; page <= 10; page++) {
    const r = await client.request(`/repos/${repo}/commits/${c.sha}?per_page=300&page=${page}`);
    files.push(...(r.data?.files ?? []));
    if (!/rel="next"/.test(r.link ?? "")) break;
  }
  const direct = tallyFiles(files).langs;
  const line = `${c.sha.slice(0, 9)} ${c.commit.message.split("\n")[0].slice(0, 60)}`;
  if (!usable) {
    console.log(`  read directly  ${line}${pr ? ` (PR #${pr.number}: totals or file count don't match)` : " (no merged PR)"}`);
    continue;
  }
  viaPR++;
  const fromPR = tallyFiles(pr.files.nodes).langs;
  if (fmt(fromPR) === fmt(direct)) {
    same++;
    console.log(`  same           ${line} (PR #${pr.number})`);
  } else {
    diffs.push(c.sha);
    console.log(`  DIFFERENT      ${line} (PR #${pr.number})\n      from PR:   ${fmt(fromPR)}\n      direct:    ${fmt(direct)}`);
  }
}
console.log(`\n${viaPR} of ${commits.length} commits would come from merged PRs; ${same} of those match their direct read exactly${diffs.length ? `, ${diffs.length} differ` : ""}.`);
process.exit(diffs.length ? 1 : 0);
