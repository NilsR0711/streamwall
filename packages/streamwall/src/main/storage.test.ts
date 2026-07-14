import { Low, Memory } from 'lowdb'
import { describe, expect, it, vi } from 'vitest'
import { flushStorage, StorageDB, StreamwallStoredData } from './storage'

function makeDB(initial: Partial<StreamwallStoredData> = {}): StorageDB {
  return new Low<StreamwallStoredData>(new Memory(), {
    stateDoc: '',
    localStreamData: [],
    ...initial,
  })
}

describe('flushStorage', () => {
  it('forces a pending throttled write to run before persisting', async () => {
    const db = makeDB()
    // Simulate lodash's throttle: the trailing update hasn't run yet, so
    // db.data still holds the stale value until flush() is called.
    let pendingUpdateRan = false
    const flushPendingUpdate = vi.fn(() => {
      pendingUpdateRan = true
      db.data.stateDoc = 'latest-update'
    })

    await flushStorage(db, flushPendingUpdate)

    expect(flushPendingUpdate).toHaveBeenCalledOnce()
    expect(pendingUpdateRan).toBe(true)
    expect(db.data.stateDoc).toBe('latest-update')
  })

  it('persists whatever is in db.data even without a pending update', async () => {
    const db = makeDB({ stateDoc: 'already-current' })
    const flushPendingUpdate = vi.fn()

    await flushStorage(db, flushPendingUpdate)

    expect(db.data.stateDoc).toBe('already-current')
  })

  it('writes the current db.data to the adapter', async () => {
    const db = makeDB()
    db.data.localStreamData = [
      { _id: 'a', kind: 'video', link: 'https://example.test' },
    ]

    await flushStorage(db, () => {})

    const persisted = await db.adapter.read()
    expect(persisted?.localStreamData).toEqual([
      { _id: 'a', kind: 'video', link: 'https://example.test' },
    ])
  })
})
