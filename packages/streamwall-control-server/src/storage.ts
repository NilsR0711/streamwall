import type { Low } from 'lowdb'
import { JSONFilePreset } from 'lowdb/node'
import process from 'node:process'
import type { AuthToken } from './auth.ts'

export interface StoredData {
  auth: {
    salt: string | null
    tokens: AuthToken[]
  }
  // Only a reference to the uplink token id is persisted. The token's scrypt
  // hash already lives in `auth.tokens`; the plaintext secret is never stored.
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

export async function loadStorage(
  dbPath: string = process.env.DB_PATH || 'storage.json',
) {
  const db = await JSONFilePreset<StoredData>(dbPath, defaultData)
  await migrateStorage(db)
  return db
}

/**
 * One-way migration that purges secrets that older versions persisted in the
 * clear. A legacy `streamwallToken.secret` is dropped; the token keeps working
 * because it is validated against its scrypt hash in `auth.tokens`.
 */
async function migrateStorage(db: StorageDB) {
  const token = db.data.streamwallToken as {
    tokenId: string
    secret?: string
  } | null
  if (token && 'secret' in token) {
    await db.update((data) => {
      data.streamwallToken = { tokenId: token.tokenId }
    })
  }
}
