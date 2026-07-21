# Contributing

## Quality gate

Before opening a PR, run the same checks CI runs:

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
```

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
