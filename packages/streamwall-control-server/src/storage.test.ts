import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { after, afterEach, describe, test } from 'node:test'

import { loadStorage, resolveDbPath } from './storage.ts'
import { setEnvForTest } from './testHelpers.ts'

describe('resolveDbPath', () => {
  const originalCwd = process.cwd()

  afterEach(() => {
    process.chdir(originalCwd)
  })

  test('defaults to a path under the home directory, not the working directory', () => {
    setEnvForTest({ DB_PATH: undefined })

    const resolved = resolveDbPath()

    assert.ok(
      resolved.startsWith(homedir()),
      `expected ${resolved} to live under the home directory`,
    )
    assert.notEqual(
      resolved,
      path.join(process.cwd(), 'storage.json'),
      'the default must not be the cwd-relative legacy path',
    )
  })

  test('the default path is stable regardless of the process working directory', () => {
    setEnvForTest({ DB_PATH: undefined })
    const fromOriginalCwd = resolveDbPath()

    const scratchCwd = mkdtempSync(path.join(tmpdir(), 'sw-cwd-'))
    process.chdir(scratchCwd)
    const fromScratchCwd = resolveDbPath()

    assert.equal(
      fromScratchCwd,
      fromOriginalCwd,
      'launching from a different directory must resolve to the same storage file',
    )
  })

  test('an explicit DB_PATH override always wins', () => {
    setEnvForTest({ DB_PATH: '/custom/path/storage.json' })

    assert.equal(resolveDbPath(), '/custom/path/storage.json')
  })
})

describe('loadStorage', () => {
  let scratchDir: string

  after(() => {
    if (scratchDir) {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  test('creates missing parent directories so a first write succeeds', async () => {
    scratchDir = mkdtempSync(path.join(tmpdir(), 'sw-storage-'))
    const dbPath = path.join(scratchDir, 'nested', 'deeper', 'storage.json')
    setEnvForTest({ DB_PATH: dbPath })

    const db = await loadStorage()
    assert.deepEqual(db.data.auth, { salt: null, tokens: [] })

    // Without creating the parent directories up front, this write would
    // fail with ENOENT (lowdb's file adapter never creates directories).
    await db.write()

    assert.equal(existsSync(dbPath), true)
  })

  test('persists writes to the resolved path', async () => {
    scratchDir = mkdtempSync(path.join(tmpdir(), 'sw-storage-'))
    const dbPath = path.join(scratchDir, 'storage.json')
    setEnvForTest({ DB_PATH: dbPath })

    const db = await loadStorage()
    db.data.auth.salt = 'test-salt'
    await db.write()

    const onDisk = JSON.parse(await readFile(dbPath, 'utf-8'))
    assert.equal(onDisk.auth.salt, 'test-salt')
  })
})
