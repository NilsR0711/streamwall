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
