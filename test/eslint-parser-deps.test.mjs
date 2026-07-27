import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

// `importX.flatConfigs.typescript` in eslint.config.mjs makes
// eslint-plugin-import-x `require('@typescript-eslint/parser')` from the
// repository root, so the package has to be reachable there.
const PARSER = '@typescript-eslint/parser'

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

// Nothing in this repo imports the parser directly — `typescript-eslint`
// pulls it in — which is exactly why it is easy to mistake the root
// declaration for a stray dependency and delete it. It is not: from
// typescript-eslint 8.65 on, npm nests the parser under
// `node_modules/typescript-eslint/node_modules/` unless something at the
// root asks for it, and eslint-plugin-import-x's root-relative `require`
// then fails with `Cannot find module '@typescript-eslint/parser'` on every
// single file (see #688).
test('the TypeScript ESLint parser is declared as a root dependency', () => {
  const { dependencies = {}, devDependencies = {} } = readJson('package.json')

  assert.ok(
    { ...dependencies, ...devDependencies }[PARSER],
    `"${PARSER}" is not declared in the root package.json. ` +
      'eslint-plugin-import-x resolves it relative to the repository root, ' +
      'so leaving it to npm\'s hoisting of "typescript-eslint" breaks ' +
      '`npm run lint` as soon as npm decides to nest it.',
  )
})

test('the lockfile installs the TypeScript ESLint parser at the root', () => {
  const { packages } = readJson('package-lock.json')

  assert.ok(
    packages[`node_modules/${PARSER}`],
    `package-lock.json has no node_modules/${PARSER} entry, so ` +
      'eslint-plugin-import-x cannot resolve it from the repository root. ' +
      'Run `npm install` to regenerate the lockfile.',
  )
})
