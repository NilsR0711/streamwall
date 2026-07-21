# Contributing

Thanks for helping improve Streamwall. This guide covers local setup, the
quality gate, and the conventions PRs are expected to follow.

## Getting started

Streamwall is an npm workspaces monorepo. Requirements:

- **Node.js 22 or newer** (`engines.node` is `>=22`; a `.nvmrc` pins the major
  so `nvm use` picks it up).
- **npm** (ships with Node) — this repo uses npm workspaces, not pnpm or yarn.

Install everything with a clean, lockfile-exact install from the repo root:

```sh
npm ci
```

Use `npm ci` rather than `npm install` — it installs the exact tree from
`package-lock.json` and hoists shared dependencies (for example Electron) to
the root `node_modules`, which the main-process tests rely on. A plain
`npm install` in a fresh checkout or git worktree can leave the tree in a
state where those tests fail to resolve their dependencies.

### Workspace map

Six packages live under `packages/` (see the root `package.json`
`workspaces` array):

| Package                     | Role                                                     |
| --------------------------- | -------------------------------------------------------- |
| `streamwall`                | The Electron desktop app (main + renderer processes).    |
| `streamwall-shared`         | Shared schemas and types used across the other packages. |
| `streamwall-control-server` | Self-hostable backend for remote control (WS + HTTP).    |
| `streamwall-control-client` | Web frontend for the control server.                     |
| `streamwall-control-ui`     | Shared control UI components (Preact).                   |
| `streamwall-control-e2e`    | Playwright end-to-end smoke tests for the control stack. |

To run the app locally: `npm run start:app`. To run the control server with
its web client: `npm run start:server`.

## Quality gate

Before opening a PR, run the same checks CI runs, from the repo root:

```sh
npm run lint          # ESLint
npm run format:check  # Prettier (also checks Markdown and YAML)
npm run typecheck     # tsc --noEmit across all workspaces
npm test              # full test suite (see runner note below)
```

Zero errors and no new warnings. Prettier runs on every PR — including
documentation-only changes — so run `npm run format` to auto-fix before
pushing.

### Builds typecheck first

Vite strips types without checking them, so `vite build` alone would happily
bundle code that does not compile. Every workspace with a `build` script
therefore declares `"prebuild": "npm run typecheck"`, which npm runs
automatically before `build`. That covers all entry points — a local
`npm -w streamwall-control-client run build`, the CI build job, and the E2E
`globalSetup` — so a type error fails the build instead of slipping through to
the separate `npm run typecheck` step.

The `streamwall` package has no `build` script — it packages through
electron-forge, whose Vite plugin strips types the same way. There the check
runs from forge's `prePackage` hook (see `packages/streamwall/forge.typecheck.ts`),
which `electron-forge package`, `make` and `publish` all pass through, so
release artifacts cannot be built from code that does not compile.
`electron-forge start` stays unchecked to keep the dev loop fast.

If you add a `build` script to a package, add the matching `prebuild` hook;
`test/workspace-metadata.test.mjs` enforces this, along with the forge hook.

### Test runners differ per package

`npm test` fans out across the workspaces, and the packages do **not** all use
the same runner:

- Most packages (`streamwall`, `streamwall-shared`, `streamwall-control-ui`,
  `streamwall-control-client`) use **Vitest** (`vitest run`).
- `streamwall-control-server` uses the **native Node test runner**
  (`node --test`) via `tsx`, single-threaded.
- Root-level workspace-metadata tests run under `node --test` too.

To run a single package's tests, target its workspace, e.g.
`npm -w streamwall-control-server test`.

`node --test` applies `--test-timeout` to every test _including the implicit
file-level test_ it wraps each file in, so the value has to clear the slowest
whole file, not the slowest single test. When a file exceeds it, the run
reports `# fail 0` alongside `# cancelled 1` and still exits non-zero — an
easily misread symptom, so check the `cancelled` counter before hunting for a
failing assertion. `test/workspace-metadata.test.mjs` keeps the configured
timeout above a floor that leaves the live-server WebSocket suites room to
finish under load.

### End-to-end tests

The E2E smoke tests need a browser that is not installed by `npm ci`. They are
**not** part of `npm test` — CI runs them in a dedicated job. To run them
locally:

```sh
npx playwright install --with-deps chromium  # once; drop --with-deps on macOS
npm run test:e2e                             # from the repo root
```

The suite builds `streamwall-control-client` itself before the first test (a
Playwright `globalSetup` hook, not the npm script), so the server has real
`dist/` assets to serve — no separate build step is needed. Set
`STREAMWALL_E2E_SKIP_CLIENT_BUILD=1` to reuse an existing `dist/` instead; CI
does this and downloads the assets from the build job so a run builds the
control client only once.

### Self-hosting image

Changes to the control server, the web control client, the shared packages or
`deploy/` are also exercised as a Docker build in CI: the image is built,
started once, and the compose stack is validated. To reproduce that locally
(needs Docker), from the repo root:

```sh
docker build -f packages/streamwall-control-server/Dockerfile .
cd deploy && cp .env.example .env && docker compose config --quiet
```

## Making changes

- **Test-driven development is expected** for behavior changes: write a failing
  test first, make it pass, then refactor. Cover happy paths, edge cases, and
  regressions. Docs-only, CI-config, or pure-formatting changes are exempt —
  say so in the PR when no tests are added.
- Prefer existing patterns and abstractions over introducing new ones.
- Do not leave TODOs, placeholders, commented-out code, or stray debug output.

## Commit and PR conventions

- PRs are **squash-merged**, so the **PR title becomes the commit subject on
  `main`** and must follow
  [Conventional Commits](https://www.conventionalcommits.org/). This is
  enforced by `.github/workflows/pr-title.yml`. Example:
  `fix(control-ui): handle empty grid`.
  Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
  `build`, `ci`, `chore`, `revert`.
- Keep individual commits focused; each should compile and pass the quality
  gate on its own.
- **No AI-tool attribution** anywhere — not in commit messages, PR
  descriptions, or code comments.

### Required status checks

Branch protection on `main` requires exactly these two checks, and nothing
else:

- `CI OK` — the aggregate gate of `.github/workflows/ci.yml`. It is green only
  when every job in that workflow succeeded or was skipped as irrelevant to the
  change (docs-only edits skip the heavy jobs). Format, lint, typecheck, tests,
  builds, packaging, E2E, the control-server Docker build, dependency review,
  workflow linting and **CodeQL**
  all report through it — CodeQL runs as a job of `ci.yml` rather than as a
  standalone workflow precisely so that its failures block a merge. Because a
  reusable-workflow call produces no run of its own, the README carries no
  separate CodeQL badge — the `CI` badge already reflects the analysis that ran
  on the latest commit on `main`.
- `Conventional Commits title` — `.github/workflows/pr-title.yml`.

Adding a job to `ci.yml` therefore also means adding it to the `ci-ok` gate's
`needs:` list; `test/ci-gate.test.mjs` fails if that is forgotten, and it also
keeps this list in sync with the workflows.

Some workflows intentionally sit outside this gate: `.github/workflows/release.yml`
(tag-triggered), CodeQL's weekly scheduled scan, which surfaces newly
disclosed patterns in code that was already merged, and the weekly
[packaging](#packaging-checks) and [deprecation](#dependency-deprecations)
checks, which react to upstream changes rather than to anything in a PR.

### Code scanning alerts

The two status checks only cover the CodeQL analysis _running_ successfully.
Alerts that a successful analysis reports are gated separately, by the
`code_scanning` rule of the same `main-protection` ruleset:

- `security_alerts_threshold: high_or_higher` — a PR that introduces a high or
  critical **security** alert cannot be merged.
- `alerts_threshold: none` — non-security **quality** alerts stay advisory.

The rule looks at the alerts a PR introduces, so a merge is never blocked by
the pre-existing backlog. Alerts below the threshold, and quality alerts of any
severity, are triaged in the Security tab instead.

Code scanning can only name the alerts a PR introduces when the PR carries a
result for every configuration it sees on `main`, and a configuration is keyed
by the analysis _category_ — which defaults to the calling workflow. `ci.yml`
and `codeql-schedule.yml` would therefore register one configuration each, and
a PR (which only runs the `ci.yml` one) would be blocked waiting for the other
forever. `codeql.yml` pins one explicit category for all callers instead;
`test/ci-gate.test.mjs` guards that.

CodeQL does produce false positives here — see the `HTMLMediaElement.src` sink
overmatch in [#301](https://github.com/NilsR0711/streamwall/issues/301). Resolve
them per alert rather than by weakening the queries repo-wide: dismiss the alert
with a `false positive` reason and a short justification, which unblocks the PR
and keeps the rule intact for everything else.

### PR checklist

- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`, and
      `npm test` all pass locally.
- [ ] New behavior is covered by tests (or the PR explains why none apply).
- [ ] PR title follows Conventional Commits.
- [ ] No AI-tool attribution in commits, PR body, or comments.

## Reporting security issues

Please do **not** file security problems as public issues. See
[SECURITY.md](SECURITY.md) for the private disclosure process.

## License

Streamwall is distributed under the [MIT License](LICENSE).

- The copyright notice at the top of `LICENSE` must remain intact — it is a
  condition of the license itself (see the "above copyright notice ... shall
  be included" clause).
- Every workspace `package.json` (root and each package under `packages/`)
  must declare `"license": "MIT"`. This is enforced by
  `test/workspace-metadata.test.mjs`, which runs as part of `npm test`.
- Code adapted from other MIT-licensed projects must keep its original
  attribution inline in the source (see
  `packages/streamwall/src/renderer/TailSpin.tsx` for an example).
- When adding a new production dependency, confirm its license permits
  redistribution inside the packaged Electron app. `npm run licenses:check`
  enforces this against the allowlist below; CI and the release workflow run
  the same check, so an incompatible license fails the merge gate instead of
  reaching a release.

### Allowed dependency licenses

Every installed production dependency (`npm ls --omit=dev --all`, across all
workspaces) must resolve to one of these SPDX identifiers:

- `0BSD`
- `Apache-2.0`
- `BSD-2-Clause`
- `BSD-3-Clause`
- `BlueOak-1.0.0`
- `CC0-1.0`
- `ISC`
- `MIT`
- `MIT-0`
- `OFL-1.1`
- `Python-2.0`
- `Unlicense`

Dual licenses (`(MIT OR Apache-2.0)`) pass when at least one branch is
allowed; conjunctions (`MIT AND …`) need every branch allowed. A missing
license field, a `SEE LICENSE IN …` reference, or a `WITH` exception fails the
check — all three need a human decision. Anything copyleft (GPL/AGPL/LGPL/MPL)
needs discussion before it is added to `scripts/check-licenses.mjs`; that list
and this section are kept in sync by `test/licenses.test.mjs`.

Distributed release binaries deliberately do not bundle a consolidated
`THIRD_PARTY_NOTICES` file: electron-forge packages each production dependency
with its own license file, which is what the MIT/BSD/ISC notice clauses
require, and a generated summary would be a second source of truth to keep
current. Revisit if a dependency's license ever demands a separate,
prominently placed notice.

## Cutting a release

electron-forge derives the packaged app's version — and the `vX.Y.Z` tag that
triggers `.github/workflows/release.yml` — from `packages/streamwall/package.json`.
The control server reports its own `package.json` version in the self-hosting
update notification and compares it against release tags, so that manifest
must always match. `packages/streamwall-control-server/src/version.test.ts`
enforces this as a regression backstop, not as the bump mechanism itself.

Releases are normally cut from the release pull request that
[release-please](https://github.com/googleapis/release-please) keeps open (see
[Changelog](#changelog) below); the command below is the manual fallback.

To bump the root manifest, both release-tracking manifests, the release-please
manifest and `package-lock.json` together in one step:

```sh
npm run release:version -- <x.y.z>
```

No other workspace tracks the release line:

- `streamwall-shared` and `streamwall-control-ui` stay pinned at `0.0.0`
  (`"private": true`, never published or versioned independently).
- `streamwall-control-client` and `streamwall-control-e2e` stay at a fixed
  `1.0.0` for the same reason.

None of the workspaces are published to the npm registry — only the Electron
app itself is distributed, via GitHub Releases.

### Packaging checks

PR CI runs `electron-forge package` as a smoke test. Ubuntu covers every code
change; macOS is added whenever the PR touches a packaging input — the
`packages/streamwall` workspace (including `forge.config.ts`), the root
manifests or `.github/workflows/ci.yml`. macOS is the only platform whose
`package` step ad-hoc re-signs the app and produces the `.app` bundle the
darwin zip maker consumes, so a macOS-specific regression is caught on the PR
that introduces it instead of a week later. The `packaging` filter in the
`Detect changes` job keeps those extra runner minutes off PRs that cannot
break packaging.

The installer makers themselves — NSIS, the macOS zip, deb and rpm — are
exercised in two other places:

- `.github/workflows/release.yml` gates every tag on an `electron-forge make`
  run that builds the deb and rpm installers natively and cross-builds the
  Windows NSIS installer plus its `latest.yml` update metadata, so a maker or
  `postMake` regression fails before the first artifact is published.
- `.github/workflows/packaging.yml` runs `electron-forge make` across all
  three platforms every Monday and on manual dispatch — this is the only
  place the darwin zip maker runs outside a release. Run it from the Actions
  tab (optionally with the `debug` input for verbose Forge logging) after a
  Forge/maker dependency bump.

Two packaging runs can share a machine: `packagerConfig.tmpdir` points each
run at a directory of its own (`forge.tmpdir.ts`). @electron/packager
otherwise stages every run under the same `<tmpdir>/electron-packager` and
deletes that directory when a run starts, which used to break a concurrent run
with a misleading `Ad-hoc codesign failed with status: 1` from the fuses
plugin (#510).

### Dependency deprecations

`.github/workflows/deprecated-deps.yml` asks the npm registry every Monday
whether any _direct_ dependency — of the root manifest or of a workspace — has
been marked `deprecated`, and fails the run if one has. `npm ci` prints those
notices too, but they scroll past in the install log, and Dependabot only opens
PRs for version bumps and advisories, never for an abandoned package. Run it
from the Actions tab, or locally:

```sh
node scripts/check-deprecated-deps.mjs
```

The script reads the committed manifests and `package-lock.json`, so it needs
no install. Transitive dependencies are deliberately not inspected: those
deprecations are frequent and rarely actionable from here.

When a deprecation cannot be migrated away from right now, add the package to
`.github/deprecated-dependencies-allowlist.json` with a reason and a tracking
issue, so the job stays actionable instead of permanently red. Allowlist
entries that no longer apply are reported as warnings and should be dropped.

### Changelog

[`CHANGELOG.md`](CHANGELOG.md) is generated, not hand-edited. Because PRs are
squash-merged and their titles are enforced as Conventional Commits, every
commit subject on `main` is machine-readable, and
[`.github/workflows/release-please.yml`](.github/workflows/release-please.yml)
turns them into changelog entries. Write the PR title for the changelog — it is
what readers of the release notes will see.

`release-please-config.json` decides which commit types are surfaced: `feat`,
`fix`, `perf`, `refactor`, `docs` and `revert` show up; `build`, `chore`, `ci`,
`style` and `test` stay hidden. Pre-1.0 a `feat:` bumps the patch version and a
breaking change bumps the minor version.

#### Releasing

1. release-please keeps a release PR open (title: `chore(main): release x.y.z`)
   containing the version bump for the root manifest, both release-tracking
   manifests, their `package-lock.json` entries and the `CHANGELOG.md` section
   for the pending release. Its description previews the release notes;
   anything merged afterwards updates the PR.
2. Merge the release PR when you want to cut the release. It arrives without
   status checks: a pull request opened by a workflow's `GITHUB_TOKEN` does not
   trigger other workflows, so neither `CI OK` nor `Conventional Commits title`
   starts on its own. **Close and immediately reopen the release PR** — the
   reopen comes from your account and starts both required checks. Wait for them
   to pass before merging; release-please reuses the same branch afterwards.
3. Tag the merge commit and push the tag:

   ```sh
   git checkout main && git pull
   git tag v<x.y.z> && git push origin v<x.y.z>
   ```

   The tag is deliberately manual: a tag pushed by a workflow's `GITHUB_TOKEN`
   does not trigger other workflows, so a release-please-created tag would never
   start [`release.yml`](.github/workflows/release.yml) and no installers would
   be built. That is also why release-please runs with `skip-github-release`.

4. `release.yml` runs the full quality gate, publishes the installers via
   electron-forge, and then copies the `CHANGELOG.md` section for that version
   into the GitHub Release body (`scripts/changelog-section.mjs`).

Because that tag is the one manual step,
[`.github/workflows/release-tag.yml`](.github/workflows/release-tag.yml) checks
every morning that the version on `main` has a matching `vX.Y.Z` tag and fails
the run when it has been missing for more than a day — otherwise a forgotten
tag stays invisible: `main` advertises a version with no GitHub Release and no
installers, while the control server's update check tells self-hosters they are
up to date. Run it from the Actions tab, or locally:

```sh
node scripts/check-release-tag.mjs
```

The same job then checks what that tag actually produced: a tag can exist while
its release is still broken — a publish leg of `release.yml` failed and left a
partially populated release behind (#453), the workflow never ran for the tag,
or the release was never taken out of draft. The check asks the GitHub API for
the release of the version on `main` and asserts the artifact kinds the `make`
job builds (`*.deb`, `*.rpm`, `*-setup-*.exe`, `latest.yml`, `*.zip`,
`latest-mac.yml`). Releases before v0.9.2 carry Squirrel's artifact names and
are skipped.

```sh
node scripts/check-release-assets.mjs
```

`test/changelog.test.mjs` and `test/release-please.test.mjs` run as part of
`npm test` and fail if `CHANGELOG.md` is missing a heading for the version
currently in `packages/streamwall/package.json`, if a hand-maintained
`## [Unreleased]` section reappears, or if the release-please configuration
drifts from the release-tracking manifests.

### Release notes: the Windows upgrade notice

Releases after v0.9.1 ship an NSIS installer plus `latest.yml` instead of the
Squirrel.Windows artifacts (`RELEASES`, `.nupkg`) that v0.9.x installs poll for
(#432, #452). Those installs therefore find no update and report no error —
they stay on their version until their owner reinstalls by hand, and only a
release note tells them to.

Until v0.9.x is safely out of circulation, paste this block at the top of the
release's `CHANGELOG.md` section **in the release PR, before merging it** —
`release.yml` overwrites the GitHub Release body with that section, so anything
added to the release by hand afterwards would be lost:

```markdown
**Windows: upgrading from v0.9.1 or older requires a manual reinstall.** Those
builds cannot see this release through their in-app updater. Uninstall the old
**Streamwall** entry (Settings → Apps → Installed apps), then download and run
`streamwall-setup-<version>.exe` below. Your config and logs in
`%APPDATA%\Streamwall` are preserved, and updates work automatically from then
on. macOS and Linux are unaffected.
```

The same notice lives in the README's [Download](README.md#download) section
for people who arrive there instead.
