import { mkdtempSync, rmSync } from 'fs'
import { Low, Memory } from 'lowdb'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, test, vi } from 'vitest'
import {
  flushStorage,
  loadStorage,
  safeUpdate,
  StorageDB,
  StreamwallStoredData,
} from './storage'

function makeDB(initial: Partial<StreamwallStoredData> = {}): StorageDB {
  return new Low<StreamwallStoredData>(new Memory(), {
    stateDoc: '',
    localStreamData: [],
    layoutPresets: [],
    favorites: [],
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

describe('safeUpdate', () => {
  it('applies the update to db.data', async () => {
    const db = makeDB()

    await safeUpdate(db, (data) => {
      data.stateDoc = 'updated'
    })

    expect(db.data.stateDoc).toBe('updated')
  })

  it('logs and swallows a rejection instead of throwing', async () => {
    const db = makeDB()
    const writeError = new Error('disk full')
    vi.spyOn(db, 'write').mockRejectedValueOnce(writeError)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      safeUpdate(db, (data) => {
        data.stateDoc = 'updated'
      }),
    ).resolves.toBeUndefined()

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist storage update'),
      writeError,
    )

    consoleError.mockRestore()
  })
})

describe('loadStorage', () => {
  test('defaults layoutPresets to an empty array for a fresh db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'streamwall-storage-test-'))
    try {
      const dbPath = join(dir, 'storage.json')
      const db = await loadStorage(dbPath)

      expect(db.data.layoutPresets).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('db.update persists a saved layout preset onto db.data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'streamwall-storage-test-'))
    try {
      const dbPath = join(dir, 'storage.json')
      const db = await loadStorage(dbPath)

      await db.update((data) => {
        data.layoutPresets = [
          { id: 'p1', name: 'My Layout', cols: 2, rows: 2, views: {} },
        ]
      })

      expect(db.data.layoutPresets).toEqual([
        { id: 'p1', name: 'My Layout', cols: 2, rows: 2, views: {} },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('favorites persistence', () => {
  test('defaults favorites to an empty array for a fresh db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'streamwall-storage-test-'))
    try {
      const dbPath = join(dir, 'storage.json')
      const db = await loadStorage(dbPath)

      expect(db.data.favorites).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('db.update persists a saved favorite onto db.data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'streamwall-storage-test-'))
    try {
      const dbPath = join(dir, 'storage.json')
      const db = await loadStorage(dbPath)

      await db.update((data) => {
        data.favorites = ['https://example.com/stream']
      })

      expect(db.data.favorites).toEqual(['https://example.com/stream'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
