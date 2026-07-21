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

### End-to-end tests

The E2E smoke tests need a browser that is not installed by `npm ci`. They are
**not** part of `npm test` — CI runs them in a dedicated job. To run them
locally:

```sh
npx playwright install --with-deps chromium
npm -w streamwall-control-e2e run test:e2e
```

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
  redistribution inside the packaged Electron app (MIT, Apache-2.0, BSD, and
  ISC are all fine; anything copyleft, e.g. GPL/AGPL, needs discussion first).
  Distributed release binaries do not currently bundle a consolidated
  `THIRD_PARTY_NOTICES` file; each dependency's own license file remains the
  source of truth via `node_modules`.

## Cutting a release

electron-forge derives the packaged app's version — and the `vX.Y.Z` tag that
triggers `.github/workflows/release.yml` — from `packages/streamwall/package.json`.
The control server reports its own `package.json` version in the self-hosting
update notification and compares it against release tags, so that manifest
must always match. `packages/streamwall-control-server/src/version.test.ts`
enforces this as a regression backstop, not as the bump mechanism itself.

To bump both release-tracking manifests (and `package-lock.json`) together in
one step:

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

### Changelog

Notable changes are tracked in [`CHANGELOG.md`](CHANGELOG.md), in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Because PRs are
squash-merged with a Conventional Commits title, each merged PR should add a
line to the `## [Unreleased]` section (grouped under `Added`, `Changed`,
`Fixed`, etc.).

When cutting a release, alongside the `release:version` bump:

1. Rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` and start a fresh empty
   `## [Unreleased]` section above it.
2. Update the compare links at the bottom of the file so `[Unreleased]` points
   at `vx.y.z...HEAD` and a new `[x.y.z]` link is added.

`test/changelog.test.mjs` runs as part of `npm test` and fails if `CHANGELOG.md`
is missing an `## [Unreleased]` section or a heading for the version currently
in `packages/streamwall/package.json`, so a version bump without a matching
changelog entry is caught before release.
