import type { Adapter, Low } from 'lowdb'
import { JSONFilePreset } from 'lowdb/node'
import { chmod, mkdir } from 'node:fs/promises'
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
 * Owner-only too, wherever the directory is this server's to decide: lowdb
 * writes through steno, which creates a fresh temp file with the default mode
 * and renames it over the storage file, so both the temp file and the renamed
 * result are briefly world-readable. A directory nobody else may traverse
 * closes that window.
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
 * Re-applies the owner-only mode after every write. steno's rename gives the
 * storage file a new inode with the process umask's mode each time, so a mode
 * set once at startup would last exactly until the first token is minted.
 */
function ownerOnly<T>(
  inner: Adapter<T>,
  dbPath: string,
  log: StorageLog | undefined,
  chmodImpl: typeof chmod,
): Adapter<T> {
  // Reported once: a filesystem that refuses chmod refuses every time, and a
  // warning per token minted would drown the log it belongs in.
  let reported = false
  return {
    read: () => inner.read(),
    async write(data: T) {
      await inner.write(data)
      const restricted = await restrict(
        dbPath,
        STORAGE_FILE_MODE,
        reported ? undefined : log,
        chmodImpl,
      )
      reported ||= !restricted
    },
  }
}

export async function loadStorage({
  log,
  chmodImpl = chmod,
}: {
  log?: StorageLog
  /** Test-only seam, so a spec can exercise a filesystem that refuses chmod. */
  chmodImpl?: typeof chmod
} = {}) {
  const dbPath = resolveDbPath()
  const dbDir = path.dirname(dbPath)
  // `recursive` returns the first directory it had to create, so this also
  // says whether the storage directory is ours to set a policy on.
  const created = await mkdir(dbDir, {
    recursive: true,
    mode: STORAGE_DIR_MODE,
  })
  const db = await JSONFilePreset<StoredData>(dbPath, defaultData)

  if (canSetMode) {
    // A directory this server created — or the default one, which belongs to
    // it alone — is tightened even when it predates this change. One the
    // operator pointed `DB_PATH` at is left as it is: it may be a home
    // directory, a working directory or a shared mount whose permissions are
    // somebody else's decision, and the file's own 0600 protects the
    // credentials either way.
    if (created !== undefined || dbDir === path.dirname(defaultDbPath())) {
      await restrict(dbDir, STORAGE_DIR_MODE, log, chmodImpl)
    }
    await restrict(dbPath, STORAGE_FILE_MODE, log, chmodImpl)
    db.adapter = ownerOnly(db.adapter, dbPath, log, chmodImpl)
  }

  return db
}
