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
const DEFAULT_DB_PATH = path.join(
  homedir(),
  '.streamwall-control-server',
  'storage.json',
)

export function resolveDbPath(): string {
  return process.env.DB_PATH || DEFAULT_DB_PATH
}

/** Owner-only, because this file holds the auth salt and every token hash. */
export const STORAGE_FILE_MODE = 0o600

/**
 * Owner-only too, and load-bearing: lowdb writes through steno, which creates a
 * fresh temp file with the default mode and renames it over the storage file,
 * so both the temp file and the renamed result are briefly world-readable. A
 * directory nobody else may traverse closes that window.
 */
export const STORAGE_DIR_MODE = 0o700

/** File modes mean nothing on Windows, where ACLs govern access instead. */
const canSetMode = process.platform !== 'win32'

/** Tightens a path that already exists, ignoring one that does not. */
async function restrictExisting(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
}

/**
 * Re-applies the owner-only mode after every write. steno's rename gives the
 * storage file a new inode with the process umask's mode each time, so a mode
 * set once at startup would last exactly until the first token is minted.
 */
function ownerOnly<T>(inner: Adapter<T>, dbPath: string): Adapter<T> {
  return {
    read: () => inner.read(),
    async write(data: T) {
      await inner.write(data)
      await restrictExisting(dbPath, STORAGE_FILE_MODE)
    },
  }
}

export async function loadStorage() {
  const dbPath = resolveDbPath()
  const dbDir = path.dirname(dbPath)
  await mkdir(dbDir, { recursive: true, mode: STORAGE_DIR_MODE })
  const db = await JSONFilePreset<StoredData>(dbPath, defaultData)

  if (canSetMode) {
    // `mkdir` sets the mode only on directories it creates, and a server that
    // has been running since before this was tightened has both a 0755
    // directory and a 0644 file, so an existing pair is fixed up here.
    await restrictExisting(dbDir, STORAGE_DIR_MODE)
    await restrictExisting(dbPath, STORAGE_FILE_MODE)
    db.adapter = ownerOnly(db.adapter, dbPath)
  }

  return db
}
