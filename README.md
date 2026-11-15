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
  Added / deleted draws additions above zero and deletions below it, each
  language in the same color as in the other views.
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

All requests go from the visitor's browser to the GitHub REST API:

1. **Repositories:** the user's own non-fork repos (`/users/:u/repos?type=owner`),
   repos they are a member of (`type=member`), private repos the token can
   read (`/user/repos`, token only), repos with their merged PRs
   (`/search/issues`), and repos where commit search finds their commits
   (`/search/commits`). A repo found only by commit search must have been
   created before the user's first commit in it and must not share most of
   its commits with a repo already counted. That filter drops re-uploaded
   copies of a project.
2. **Commits:** `/repos/:r/commits?author=:u` on each repo's default branch,
   so only accepted commits count. Merge commits are skipped. A commit that
   appears in several repos (same SHA) counts once. The cap is 5,000 commits
   per repo.
3. **Lines per language:** `/repos/:r/commits/:sha` lists each changed file
   with its additions and deletions, following pagination for big commits.
   Each file goes to a language by its extension or filename
   (`public/js/languages.js`: `.py` is Python, `.tsx` is TypeScript,
   `Makefile` is Makefile, and so on). These files are not counted:
   - data and config formats (JSON, YAML, TOML, XML)
   - prose (Markdown, text)
   - lockfiles
   - binaries
   - generated or vendored code (`node_modules/`, `vendor/`, `dist/`,
     `*.min.js`, protobuf output, …)

   The page reports how many lines were left out. Commits are dated by
   their author date.

Color follows the language, not its rank in the current range. The seven
languages with the most lines over the user's whole history get fixed colors,
and any others are grouped as "Other". The palettes are in
`public/css/styles.css` and were checked for lightness, contrast and
color-vision separation against both chart backgrounds.

### Rate limits and caching

This costs one request per commit, so a token is close to essential:
GitHub allows 60 requests an hour without one and 5,000 with one. Commit
diffs are fetched in a stable shuffled order. If a limit stops a load, the
chart is an even sample of the history rather than only its newest part,
and the page says how many commits were read. Everything is cached in
`localStorage`: commit lists for 12 hours, and diffs for 30 days (they never
change, and are shared between users and tokens). The next load only fetches
what's missing.

### Token permissions

| Goal | Repository access | Repository permissions |
| --- | --- | --- |
| Public data only | Public repositories | none |
| Include private repos | All repositories (or selected) | Contents: read (Metadata: read is added automatically) |

Contents covers listing commits and reading their diffs. Metadata covers
listing repositories. No account permissions are needed. A fine-grained token
has one resource owner (your account or one organization), so an
organization's private repos need a token owned by that organization, and the
organization may require approval. The token stays in the visitor's browser
and is sent only to api.github.com.

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
