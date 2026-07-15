import { Low, Memory } from 'lowdb'
import { JSONFilePreset } from 'lowdb/node'
import { LayoutPreset, StreamDataContent } from 'streamwall-shared'
import log from './logger'

export interface StreamwallStoredData {
  stateDoc: string
  localStreamData: StreamDataContent[]
  layoutPresets: LayoutPreset[]
  favorites: string[]
}

const defaultData: StreamwallStoredData = {
  stateDoc: '',
  localStreamData: [],
  layoutPresets: [],
  favorites: [],
}

export type StorageDB = Low<StreamwallStoredData>

export async function loadStorage(dbPath: string) {
  let db: StorageDB

  try {
    db = await JSONFilePreset<StreamwallStoredData>(dbPath, defaultData)
  } catch (err) {
    log.warn(
      'Failed to load storage at',
      dbPath,
      ' -- changes will not be persisted',
    )
    db = new Low<StreamwallStoredData>(new Memory(), defaultData)
  }

  return db
}

/**
 * Applies an update and persists it, logging (rather than throwing on) a
 * rejected write -- e.g. a full disk or a permissions error -- so a single
 * failed persist doesn't surface as an unhandled promise rejection.
 */
export async function safeUpdate(
  db: StorageDB,
  fn: (data: StreamwallStoredData) => void,
): Promise<void> {
  try {
    await db.update(fn)
  } catch (err) {
    console.error('Failed to persist storage update', err)
  }
}

/**
 * Guarantees the latest state is on disk before the app quits.
 *
 * Writes that go through a throttled updater (e.g. the Yjs stateDoc persist)
 * can have a trailing call still pending when the app quits, so `db.data`
 * may not yet hold the latest value. `flushPendingUpdate` should synchronously
 * force that pending call to run (e.g. lodash's `throttled.flush()`) before
 * this writes `db.data` to the adapter.
 */
export async function flushStorage(
  db: StorageDB,
  flushPendingUpdate: () => void,
): Promise<void> {
  flushPendingUpdate()
  await db.write()
}
