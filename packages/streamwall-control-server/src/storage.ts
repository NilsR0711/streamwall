import type { Low } from 'lowdb'
import { JSONFilePreset } from 'lowdb/node'
import { mkdir } from 'node:fs/promises'
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

export async function loadStorage() {
  const dbPath = resolveDbPath()
  await mkdir(path.dirname(dbPath), { recursive: true })
  const db = await JSONFilePreset<StoredData>(dbPath, defaultData)
  return db
}
