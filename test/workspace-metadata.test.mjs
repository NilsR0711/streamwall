import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readPackageJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

test('every workspace package.json declares the MIT license', () => {
  const rootPackageJson = readPackageJson('package.json')
  const packageJsonPaths = [
    'package.json',
    ...rootPackageJson.workspaces.map((workspace) =>
      join(workspace, 'package.json'),
    ),
  ]

  for (const relativePath of packageJsonPaths) {
    const { license } = readPackageJson(relativePath)
    assert.equal(license, 'MIT', `${relativePath} is missing "license": "MIT"`)
  }
})
