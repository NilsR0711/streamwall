import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { SERVER_VERSION } from './updateCheck.ts'

function packageVersion(relativePath: string): string {
  const manifest = JSON.parse(
    readFileSync(path.join(import.meta.dirname, relativePath), 'utf8'),
  ) as { version: string }
  return manifest.version
}

describe('release version alignment', () => {
  // The update check compares SERVER_VERSION against the repo's `vX.Y.Z`
  // release tags, which electron-forge derives from the `streamwall` package
  // version. If the two drift, a self-hoster is told an update is available
  // (or not) based on a version that never existed — so pin them together.
  test('control-server version matches the released streamwall version', () => {
    assert.equal(
      SERVER_VERSION,
      packageVersion('../../streamwall/package.json'),
    )
  })

  test('SERVER_VERSION is read from the control-server manifest', () => {
    assert.equal(SERVER_VERSION, packageVersion('../package.json'))
  })
})
