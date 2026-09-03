import type { Adapter, Low } from 'lowdb'
import { Low as LowCore, Memory } from 'lowdb'
import { JSONFilePreset } from 'lowdb/node'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import type { AuthToken } from './auth.ts'

export interface StoredData {
  auth: {
    salt: string | null
    tokens: AuthToken[]
  }
  // Only the uplink token's *id* is persisted. Its secret is never stored in
  // clear: the token is verified against the scrypt hash held in `auth.tokens`
  // (like every other token), and the plaintext secret is revealed only once,
  // at creation time.
  streamwallToken: null | {
    tokenId: string
  }
}

const defaultData: StoredData = {
  auth: {
    salt: null,
    tokens: [],
  },
  streamwallToken: null,
}

export type StorageDB = Low<StoredData>

// Anchored to the user's home directory rather than the process's working
// directory, so the server always finds the same storage file regardless of
// where (or by what process manager) it was started -- mirroring how the
// desktop app resolves its storage path via `app.getPath('userData')`.
function defaultDbPath(): string {
  return path.join(homedir(), '.streamwall-control-server', 'storage.json')
}

export function resolveDbPath(): string {
  return process.env.DB_PATH || defaultDbPath()
}

/** Owner-only, because this file holds the auth salt and every token hash. */
export const STORAGE_FILE_MODE = 0o600

/**
 * Owner-only too, wherever the directory is this server's to decide: lowdb's
 * own file adapter writes through steno, which creates a fresh temp file and
 * renames it over the storage file, so a directory nobody else may traverse
 * is what keeps that temp file from being briefly visible to other accounts.
 */
export const STORAGE_DIR_MODE = 0o700

/** File modes mean nothing on Windows, where ACLs govern access instead. */
const canSetMode = process.platform !== 'win32'

/** The slice of the structured logger this module reports through. */
interface StorageLog {
  warn(fields: object, msg: string): void
}

/**
 * Tightens a path, reporting rather than failing when it cannot: hardening is
 * best effort, and a storage directory the process may read and write but not
 * chmod (a root-owned bind mount, a filesystem without POSIX modes) must not
 * take the server down or turn a write that landed into a failure.
 */
async function restrict(
  target: string,
  mode: number,
  log: StorageLog | undefined,
  chmodImpl: typeof chmod,
): Promise<boolean> {
  try {
    await chmodImpl(target, mode)
    return true
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException
    if (code !== 'ENOENT') {
      log?.warn(
        { err, path: target, mode: mode.toString(8) },
        'Could not restrict storage permissions',
      )
    }
    return false
  }
}

/**
 * A drop-in for lowdb's own node JSON file adapter (which writes through
 * `steno`) that never lets the storage file exist with a wider mode than
 * `STORAGE_FILE_MODE` — not even for the instant between the temp file being
 * created and the rename that publishes it.
 *
 * steno creates its temp file with the process umask's default mode and only
 * relies on a `chmod` *after* the write to narrow it; that left the file
 * briefly world-readable on every single write (issue #820). Creating the
 * temp file with the right mode from the moment it exists closes that window
 * entirely, because `rename` carries a file's mode with it — the published
 * file never has any mode but the one its temp file was given.
 *
 * A stale temp file left behind by a crash before this fix shipped could
 * still be sitting there with the umask's wider mode; `write` unlinks it
 * first so every temp file this adapter creates is guaranteed to be a fresh
 * inode `writeFile`'s `mode` option actually applies to (that option is only
 * honoured when the file does not already exist).
 */
class OwnerOnlyJSONFile implements Adapter<StoredData> {
  #filename: string
  #tempFilename: string
  // Serializes overlapping writes onto the same temp file, the same way
  // steno's own writer does.
  #writeChain: Promise<void> = Promise.resolve()
  #writeFileImpl: typeof writeFile

  constructor(filename: string, writeFileImpl: typeof writeFile = writeFile) {
    this.#filename = filename
    this.#tempFilename = path.join(
      path.dirname(filename),
      `.${path.basename(filename)}.tmp`,
    )
    this.#writeFileImpl = writeFileImpl
  }

  async read(): Promise<StoredData | null> {
    let raw: string
    try {
      raw = await readFile(this.#filename, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw err
    }
    return JSON.parse(raw) as StoredData
  }

  write(data: StoredData): Promise<void> {
    const str = JSON.stringify(data, null, 2)
    const run = this.#writeChain.then(() => this.#writeNow(str))
    // A rejected write must not wedge every write queued after it.
    this.#writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #writeNow(str: string): Promise<void> {
    try {
      await unlink(this.#tempFilename)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }
    // Created at STORAGE_FILE_MODE from the first byte, then renamed over the
    // target: the temp file is never briefly wider, and the rename carries
    // that mode onto the file it publishes.
    await this.#writeFileImpl(this.#tempFilename, str, {
      encoding: 'utf-8',
      mode: STORAGE_FILE_MODE,
    })
    await rename(this.#tempFilename, this.#filename)
  }
}

/** Builds the lowdb instance production code and specs both go through. */
async function createDb(
  dbPath: string,
  writeFileImpl: typeof writeFile,
): Promise<StorageDB> {
  // `NODE_ENV=test` is lowdb's own signal (in `JSONFilePreset`) to swap in an
  // in-memory adapter; mirrored here so this module behaves identically to
  // the preset it replaces for real (non-Windows) use.
  if (process.env.NODE_ENV === 'test') {
    const db = new LowCore<StoredData>(new Memory<StoredData>(), defaultData)
    await db.read()
    return db
  }
  if (canSetMode) {
    const db = new LowCore<StoredData>(
      new OwnerOnlyJSONFile(dbPath, writeFileImpl),
      defaultData,
    )
    await db.read()
    return db
  }
  // Windows: modes are meaningless, so this keeps using lowdb's own adapter
  // exactly as before.
  return JSONFilePreset<StoredData>(dbPath, defaultData)
}

export async function loadStorage({
  log,
  chmodImpl = chmod,
  writeFileImpl = writeFile,
}: {
  log?: StorageLog
  /** Test-only seam, so a spec can exercise a filesystem that refuses chmod. */
  chmodImpl?: typeof chmod
  /** Test-only seam, so a spec can observe the mode a temp file is created with. */
  writeFileImpl?: typeof writeFile
} = {}): Promise<StorageDB> {
  const dbPath = resolveDbPath()
  const dbDir = path.dirname(dbPath)
  await mkdir(dbDir, { recursive: true, mode: STORAGE_DIR_MODE })
  const db = await createDb(dbPath, writeFileImpl)

  if (canSetMode) {
    // Tightened whenever this is the storage directory — not only when the
    // server just created it, or when it is the default path. Issue #820:
    // a directory an operator pointed a custom DB_PATH at was previously left
    // exactly as loose as it was found, even though it is where the auth salt
    // and every token hash live. Best effort: a directory the process may
    // read and write but not chmod (a root-owned bind mount, a filesystem
    // without POSIX modes) must not take the server down.
    await restrict(dbDir, STORAGE_DIR_MODE, log, chmodImpl)
    // Tightens a file left loose by a pre-#820 server; every write from here
    // on already lands at STORAGE_FILE_MODE via OwnerOnlyJSONFile itself.
    await restrict(dbPath, STORAGE_FILE_MODE, log, chmodImpl)
  }

  return db
}
