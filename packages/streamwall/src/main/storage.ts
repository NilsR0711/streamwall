import { Low, Memory } from 'lowdb'
import { JSONFilePreset } from 'lowdb/node'
import { LayoutPreset, StreamDataContent } from 'streamwall-shared'

export interface StreamwallStoredData {
  stateDoc: string
  localStreamData: StreamDataContent[]
  layoutPresets: LayoutPreset[]
}

const defaultData: StreamwallStoredData = {
  stateDoc: '',
  localStreamData: [],
  layoutPresets: [],
}

export type StorageDB = Low<StreamwallStoredData>

export async function loadStorage(dbPath: string) {
  let db: StorageDB

  try {
    db = await JSONFilePreset<StreamwallStoredData>(dbPath, defaultData)
  } catch (err) {
    console.warn(
      'Failed to load storage at',
      dbPath,
      ' -- changes will not be persisted',
    )
    db = new Low<StreamwallStoredData>(new Memory(), defaultData)
  }

  return db
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
