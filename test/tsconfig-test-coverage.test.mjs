import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readPackageJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

function workspaceDirs() {
  const rootPackageJson = readPackageJson('package.json')
  return rootPackageJson.workspaces
}

// tsconfig.json is allowed a small amount of JSONC (`//` line comments) in
// this repo - strip them before parsing so this guard does not have to take
// on a full JSONC dependency for one feature.
function readTsconfig(relativePath) {
  const raw = readFileSync(join(rootDir, relativePath), 'utf8')
  const withoutComments = raw.replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(withoutComments)
}

// `npm run typecheck` runs `tsc --noEmit -p tsconfig.json` per workspace, and
// `vitest run`/`node --test` do no type checking of their own - so a workspace
// tsconfig that excludes its own test files is never type-checked by any CI
// job. That gap let `packages/streamwall`'s test files go uncovered until
// issue #748 fixed it; this guard keeps it from silently reappearing there or
// in any newly added package.
test('no workspace tsconfig.json excludes its own test files from typechecking', () => {
  for (const workspace of workspaceDirs()) {
    const tsconfigPath = join(workspace, 'tsconfig.json')
    if (!existsSync(join(rootDir, tsconfigPath))) {
      continue
    }

    const { exclude = [] } = readTsconfig(tsconfigPath)
    const testExcludes = exclude.filter((pattern) =>
      /\.test\.(ts|tsx)/.test(pattern),
    )

    assert.deepEqual(
      testExcludes,
      [],
      `${tsconfigPath} excludes test files from typechecking via ` +
        `${JSON.stringify(testExcludes)} - this package's own tests would ` +
        'never be type-checked by any CI job',
    )
  }
})
