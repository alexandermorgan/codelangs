# What do you code in?

Enter a GitHub username and see the programming languages of that person's
accepted commits over time, measured in lines of code changed. It is modelled
on Rhys Sullivan's [Are you going exponential?](https://areyougoingexponential.rhys.dev/)
and [shiptalkers](https://github.com/RhysSullivan/shiptalkers).

The site is 100% static: HTML, CSS and ES modules in `public/`, with no build
step. It runs on Cloudflare as a Worker with static assets and no script.
Charts are drawn with [pele](https://pele.run).

## Run it locally

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:8787 (or http://localhost:8787/?u=some-username).

## What you can change on the page

- **Percent / Lines.** Percent (the default) stacks each month's share of lines
  changed per language into one continuous band per language. Lines draws one
  overlapping line per language.
- **Combined / Added / deleted.** Combined counts additions plus deletions.
  Added / deleted draws additions above zero in greens and deletions below
  zero in reds, one shade per language.
- **Time span.** A two-thumb slider, in whole months, from the account's
  creation (or its first commit, if earlier) to the current month. The thumbs
  can meet but not cross.
- **Copy SVG / Download SVG.** These save the chart as a standalone SVG, with
  a title, in the current theme.
- **Theme.** Follows the system setting until the switch is used, then
  remembers the choice. The switch is the same one as on alexandermorgan.dev.

The username, scale, view and range are kept in the URL, so a link reproduces
the chart (for example `/?u=octocat&scale=lines&view=split&from=2020-01&to=2024-12`).

## Where the numbers come from

All requests go from the visitor's browser to the public GitHub REST API:

1. Repositories: the user's own non-fork repos (`/users/:u/repos?type=owner`),
   repos they are a member of (`type=member`), repos with their merged PRs
   (`/search/issues`), and repos where commit search finds their commits
   (`/search/commits`). A repo found only by commit search must have been
   created before the user's first commit in it and must not share most of its
   commits with a repo already counted. That filter drops re-uploaded copies
   of a project, which would otherwise count the same commits twice.
2. Lines: `/repos/:r/stats/contributors` gives weekly additions, deletions and
   commits per author on the default branch. Weeks are split by day into
   months. GitHub omits line counts for repos with 10,000+ commits and lists
   only the top 100 contributors, so for those the user's merged PRs
   (`/repos/:r/pulls/:n`) are used instead.
3. Languages: each repo's lines are split between its languages in proportion
   to `/repos/:r/languages` bytes. GitHub's stats are not per file, so this is
   an approximation.

Color follows the language, not its rank in the current range. The seven
languages with the most lines over the user's whole history get fixed colors,
and any others are grouped as "Other". The palettes are in `public/css/styles.css`
and were checked for lightness, contrast and color-vision separation against
both chart backgrounds.

Without a token, GitHub allows 60 requests an hour, and a profile costs roughly
two per repository. Results are cached in `localStorage` for 12 hours, per
repository, so a rate-limited load resumes where it stopped. Visitors can save
a fine-grained token (public repos, no permissions) in the page to get 5,000
requests an hour. It stays in their browser and is sent only to api.github.com.

## How the charts use pele

Mermaid's `xychart`, which pele renders, has line and bar series but no stacked
bars and no date axis. `public/js/chart.js` writes the data as an `xychart` and
renders it with pele. It then adjusts the resulting SVG:

- For the stacked view, pele is given each language's running total. Each
  language's bars are then replaced by one stepped shape spanning whole
  months, starting where the language below ends.
- The month/year axis is drawn in place of pele's category labels.
- Series and legend colors are set from the CSS variables above.

pele's modules are vendored in `public/vendor/pele` (only the core and the
xychart diagram). After upgrading the `pele` dev dependency, run:

```bash
npm run vendor
```

## Tests

```bash
npm test
```

The tests run the data pipeline against a fake GitHub API (`test/fixture.mjs`).

## Deploy

`wrangler.jsonc` serves `public/` as static assets. When it's time to host it,
add a `routes` entry for the domain (as in the personal website's config) and
run:

```bash
npm run deploy
```
