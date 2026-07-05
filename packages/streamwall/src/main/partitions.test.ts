import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  allocateViewPartition,
  BROWSE_PARTITION,
  createPartitionAllocator,
  hardenSession,
} from './partitions'

type PermissionHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
) => void

function fakeSession() {
  let handler: PermissionHandler | null = null
  return {
    setPermissionRequestHandler(next: PermissionHandler | null) {
      handler = next
    },
    request(permission: string): boolean {
      assert.ok(handler, 'a permission request handler must be registered')
      let granted: boolean | undefined
      handler({}, permission, (value) => {
        granted = value
      })
      assert.notEqual(granted, undefined, 'handler must invoke the callback')
      return granted!
    },
  }
}

test('createPartitionAllocator yields sequential names with the given prefix', () => {
  const allocate = createPartitionAllocator('view-')
  assert.equal(allocate(), 'view-0')
  assert.equal(allocate(), 'view-1')
  assert.equal(allocate(), 'view-2')
})

test('allocated partitions are ephemeral (never persisted to disk)', () => {
  const allocate = createPartitionAllocator('view-')
  for (let i = 0; i < 5; i++) {
    assert.ok(
      !allocate().startsWith('persist:'),
      'partition must not use the persistent "persist:" prefix',
    )
  }
})

test('separate allocators maintain independent counters', () => {
  const a = createPartitionAllocator('a-')
  const b = createPartitionAllocator('b-')
  assert.equal(a(), 'a-0')
  assert.equal(a(), 'a-1')
  assert.equal(b(), 'b-0')
})

test('allocateViewPartition returns a unique ephemeral partition on every call', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 100; i++) {
    const partition = allocateViewPartition()
    assert.ok(partition.startsWith('view-'), 'view partitions are prefixed')
    assert.ok(
      !partition.startsWith('persist:'),
      'view partitions are ephemeral',
    )
    assert.ok(!seen.has(partition), `partition ${partition} must be unique`)
    seen.add(partition)
  }
})

test('BROWSE_PARTITION is ephemeral and isolated from stream views', () => {
  assert.ok(
    !BROWSE_PARTITION.startsWith('persist:'),
    'browse partition must be ephemeral',
  )
  assert.ok(
    !BROWSE_PARTITION.startsWith('view-'),
    'browse partition must not collide with the stream-view namespace',
  )
})

test('hardenSession registers a permission request handler', () => {
  const session = fakeSession()
  let registered = false
  const original = session.setPermissionRequestHandler
  session.setPermissionRequestHandler = (handler) => {
    registered = true
    original(handler)
  }
  hardenSession(session)
  assert.ok(registered, 'hardenSession must register a permission handler')
})

test('hardened session rejects every permission request', () => {
  const session = fakeSession()
  hardenSession(session)
  for (const permission of [
    'media',
    'geolocation',
    'notifications',
    'midi',
    'clipboard-read',
  ]) {
    assert.equal(
      session.request(permission),
      false,
      `permission "${permission}" must be denied`,
    )
  }
})
