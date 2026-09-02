import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { after, afterEach, describe, test } from 'node:test'

import {
  loadStorage,
  resolveDbPath,
  STORAGE_DIR_MODE,
  STORAGE_FILE_MODE,
} from './storage.ts'
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

/** Every throwaway directory a spec made, so none is left behind. */
const scratchDirs: string[] = []
function makeScratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-storage-'))
  scratchDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('loadStorage', () => {
  test('creates missing parent directories so a first write succeeds', async () => {
    const dbPath = path.join(
      makeScratchDir(),
      'nested',
      'deeper',
      'storage.json',
    )
    setEnvForTest({ DB_PATH: dbPath })

    const db = await loadStorage()
    assert.deepEqual(db.data.auth, { salt: null, tokens: [] })

    // Without creating the parent directories up front, this write would
    // fail with ENOENT (lowdb's file adapter never creates directories).
    await db.write()

    assert.equal(existsSync(dbPath), true)
  })

  test('persists writes to the resolved path', async () => {
    const dbPath = path.join(makeScratchDir(), 'storage.json')
    setEnvForTest({ DB_PATH: dbPath })

    const db = await loadStorage()
    db.data.auth.salt = 'test-salt'
    await db.write()

    const onDisk = JSON.parse(await readFile(dbPath, 'utf-8'))
    assert.equal(onDisk.auth.salt, 'test-salt')
  })
})

describe('storage file permissions', () => {
  // Modes are a POSIX concept; Windows governs access through ACLs, and
  // `loadStorage` deliberately leaves them alone there.
  const posixOnly =
    process.platform === 'win32' ? 'POSIX file modes only' : undefined

  /** The permission bits of `target`. */
  async function modeOf(target: string): Promise<number> {
    return (await stat(target)).mode & 0o777
  }

  test(
    'creates the storage directory owner-only',
    { skip: posixOnly },
    async () => {
      const scratchDir = makeScratchDir()
      const dbPath = path.join(scratchDir, 'nested', 'deeper', 'storage.json')
      setEnvForTest({ DB_PATH: dbPath })

      await loadStorage()

      assert.equal(await modeOf(path.dirname(dbPath)), STORAGE_DIR_MODE)
      // `mkdir` applies its mode to every directory it creates, and that mode
      // — not the chmod afterwards — is what keeps the storage directory from
      // being briefly world-readable while it is being set up.
      assert.equal(
        await modeOf(path.join(scratchDir, 'nested')),
        STORAGE_DIR_MODE,
        'every directory created for the storage file must be owner-only',
      )
    },
  )

  test('creates the storage file owner-only', { skip: posixOnly }, async () => {
    const dbPath = path.join(makeScratchDir(), 'storage.json')
    setEnvForTest({ DB_PATH: dbPath })

    const db = await loadStorage()
    db.data.auth.salt = 'test-salt'
    await db.write()

    assert.equal(await modeOf(dbPath), STORAGE_FILE_MODE)
  })

  test(
    'keeps the file owner-only across repeated writes',
    { skip: posixOnly },
    async () => {
      // lowdb writes through steno, which renames a fresh temp file over the
      // storage file, so every write hands it a new inode with the umask's mode.
      const dbPath = path.join(makeScratchDir(), 'storage.json')
      setEnvForTest({ DB_PATH: dbPath })

      const db = await loadStorage()
      for (let i = 0; i < 3; i++) {
        db.data.auth.salt = `salt-${i}`
        await db.write()
        assert.equal(await modeOf(dbPath), STORAGE_FILE_MODE, `write ${i}`)
      }
    },
  )

  test(
    'tightens a file left loose by an older server',
    { skip: posixOnly },
    async () => {
      const dbDir = path.join(makeScratchDir(), 'existing')
      const dbPath = path.join(dbDir, 'storage.json')
      mkdirSync(dbDir, { mode: 0o755 })
      await writeFile(
        dbPath,
        JSON.stringify({
          auth: { salt: 'old', tokens: [] },
          streamwallToken: null,
        }),
      )
      chmodSync(dbDir, 0o755)
      chmodSync(dbPath, 0o644)
      setEnvForTest({ DB_PATH: dbPath })

      const db = await loadStorage()

      assert.equal(db.data.auth.salt, 'old', 'the existing store is still read')
      assert.equal(await modeOf(dbPath), STORAGE_FILE_MODE)
      // A directory the operator pointed DB_PATH at is left alone: it may be a
      // home or working directory whose permissions are not ours to decide.
      assert.equal(
        await modeOf(dbDir),
        0o755,
        'an existing directory the server did not create keeps its mode',
      )
    },
  )
})
