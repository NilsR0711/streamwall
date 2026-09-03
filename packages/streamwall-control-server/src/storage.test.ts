import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { chmod } from 'node:fs/promises'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { after, afterEach, describe, test } from 'node:test'

import { loadStorage, resolveDbPath } from './storage.ts'
import { recordingLogger, setEnvForTest } from './testHelpers.ts'

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

      assert.equal(await modeOf(path.dirname(dbPath)), 0o700)
      // `mkdir` applies its mode to every directory it creates, and that mode
      // — not the chmod afterwards — is what keeps the storage directory from
      // being briefly world-readable while it is being set up.
      assert.equal(
        await modeOf(path.join(scratchDir, 'nested')),
        0o700,
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

    assert.equal(await modeOf(dbPath), 0o600)
  })

  test(
    'keeps the file owner-only across repeated writes',
    { skip: posixOnly },
    async () => {
      // Every write renames a fresh temp file over the storage file, so this
      // pins that the new inode lands at STORAGE_FILE_MODE every time, not
      // just on the first write.
      const dbPath = path.join(makeScratchDir(), 'storage.json')
      setEnvForTest({ DB_PATH: dbPath })

      const db = await loadStorage()
      for (let i = 0; i < 3; i++) {
        db.data.auth.salt = `salt-${i}`
        await db.write()
        assert.equal(await modeOf(dbPath), 0o600, `write ${i}`)
      }
    },
  )

  test(
    'tightens the default storage directory left loose by an older server',
    { skip: posixOnly },
    async () => {
      // The upgrade case the issue is about: a bare-metal server that has been
      // running since before this change has a 0755 directory of its own.
      const home = makeScratchDir()
      const dbDir = path.join(home, '.streamwall-control-server')
      mkdirSync(dbDir, { mode: 0o755 })
      chmodSync(dbDir, 0o755)
      setEnvForTest({ DB_PATH: undefined, HOME: home })

      await loadStorage()

      assert.equal(await modeOf(dbDir), 0o700)
    },
  )

  test(
    'reports a filesystem that refuses to restrict, and keeps working',
    { skip: posixOnly },
    async () => {
      // A root-owned bind mount or a filesystem without POSIX modes must not
      // take the server down, nor turn a write that landed into a failure.
      const dbPath = path.join(makeScratchDir(), 'storage.json')
      setEnvForTest({ DB_PATH: dbPath })
      const { entries, log } = recordingLogger()
      const refuse = () => {
        const err = new Error(
          'operation not permitted',
        ) as NodeJS.ErrnoException
        err.code = 'EPERM'
        return Promise.reject(err)
      }

      const db = await loadStorage({
        log: log as unknown as { warn(fields: object, msg: string): void },
        chmodImpl: refuse as unknown as typeof chmod,
      })
      for (let i = 0; i < 3; i++) {
        db.data.auth.salt = `salt-${i}`
        await db.write()
      }

      const onDisk = JSON.parse(await readFile(dbPath, 'utf-8'))
      assert.equal(onDisk.auth.salt, 'salt-2', 'writes must still land')
      const warnings = entries.filter((entry) =>
        entry.msg?.includes('Could not restrict storage permissions'),
      )
      assert.equal(
        warnings.length,
        2,
        'once for the directory, once for the file, both at the startup ' +
          'pass — a write no longer chmods at all, so none of the 3 writes ' +
          'above adds another warning',
      )
    },
  )

  test(
    'tightens a file and a custom DB_PATH directory left loose by an older server',
    { skip: posixOnly },
    async () => {
      // Issue #820: a directory the operator pointed a custom DB_PATH at —
      // not the default, not created by this run — used to be left exactly
      // as loose as it was found, even though it is where the credentials
      // live. It is now tightened on a best-effort basis, same as the file.
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
      assert.equal(await modeOf(dbPath), 0o600)
      assert.equal(
        await modeOf(dbDir),
        0o700,
        'a custom DB_PATH directory is tightened too, not just the default one',
      )
    },
  )

  test(
    'never gives the storage file a wider mode than 0600, not even for an instant',
    { skip: posixOnly },
    async () => {
      // Issue #820: lowdb writes through steno, which creates its temp file
      // with the process umask's default mode and renames it over the
      // target, so the live file was 0644 from the rename until the
      // then-async chmod landed. Spy on the raw `writeFile` call the adapter
      // uses to create that temp file, and assert the mode is already
      // correct the instant the inode is created — before the rename ever
      // makes it visible at the storage path.
      const dbPath = path.join(makeScratchDir(), 'storage.json')
      setEnvForTest({ DB_PATH: dbPath })
      const observedModes: number[] = []
      const spyWriteFile: typeof writeFile = async (file, data, options) => {
        const result = await writeFile(file, data, options)
        observedModes.push(await modeOf(file as string))
        return result
      }

      const db = await loadStorage({ writeFileImpl: spyWriteFile })
      for (let i = 0; i < 5; i++) {
        db.data.auth.salt = `salt-${i}`
        await db.write()
      }

      assert.ok(observedModes.length > 0, 'the spy must have observed writes')
      assert.ok(
        observedModes.every((mode) => mode === 0o600),
        `every temp file must be created at 0600, observed: ${observedModes
          .map((mode) => mode.toString(8))
          .join(', ')}`,
      )
    },
  )

  test(
    'resets a stale temp file left at a wider mode by a crash or an older release',
    { skip: posixOnly },
    async () => {
      // POSIX `open()` only applies the `mode` argument when it actually
      // creates the file: if `.storage.json.tmp` already exists (left behind
      // by a process that died between the write and the rename, or by a
      // pre-#820 server build), `writeFile(tmp, data, { mode })` would
      // silently keep that leftover file's wider mode unless the adapter
      // resets it first.
      const dbPath = path.join(makeScratchDir(), 'storage.json')
      const tempPath = path.join(
        path.dirname(dbPath),
        `.${path.basename(dbPath)}.tmp`,
      )
      setEnvForTest({ DB_PATH: dbPath })
      await writeFile(tempPath, '{}', { mode: 0o644 })
      assert.equal(
        await modeOf(tempPath),
        0o644,
        'the leftover temp file must start wide',
      )

      const db = await loadStorage()
      db.data.auth.salt = 'test-salt'
      await db.write()

      assert.equal(
        await modeOf(dbPath),
        0o600,
        "the published file must not inherit the leftover temp file's mode",
      )
    },
  )
})
