import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  allocateViewPartition,
  BROWSE_PARTITION,
  createPartitionAllocator,
  hardenSession,
  installRequestSSRFGuard,
} from './partitions'

type RequestListener = (
  details: { url: string },
  callback: (response: { cancel: boolean }) => void,
) => void

type PermissionHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
) => void

function fakeSession() {
  let handler: PermissionHandler | null = null
  let requestListener: RequestListener | null = null
  return {
    setPermissionRequestHandler(next: PermissionHandler | null) {
      handler = next
    },
    webRequest: {
      onBeforeRequest(listener: RequestListener) {
        requestListener = listener
      },
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
    async requestURL(url: string): Promise<boolean> {
      assert.ok(requestListener, 'a request listener must be registered')
      let cancel: boolean | undefined
      await new Promise<void>((resolve) => {
        requestListener!({ url }, (response) => {
          cancel = response.cancel
          resolve()
        })
      })
      assert.notEqual(cancel, undefined, 'listener must invoke the callback')
      return cancel!
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

test('hardenSession also installs the network-layer SSRF guard', async () => {
  const session = fakeSession()
  hardenSession(session)
  assert.equal(
    await session.requestURL('http://169.254.169.254/latest/meta-data/'),
    true,
    'a request to the cloud-metadata endpoint must be cancelled',
  )
  assert.equal(
    await session.requestURL('https://cdn.twitch.tv/'),
    false,
    'a public request must be allowed',
  )
})

// A resolver stub keeps the guard tests off the network and deterministic.
const guardWith = (
  reasons: Record<string, string | null>,
  allowedOrigins?: readonly string[],
) => {
  const session = fakeSession()
  installRequestSSRFGuard(session, {
    allowedOrigins,
    findBlockReason: async (url) => reasons[url] ?? null,
  })
  return session
}

test('installRequestSSRFGuard cancels requests the reason lookup flags', async () => {
  const session = guardWith({
    'http://segments.evil.example/0.ts': 'resolves to private address 10.0.0.5',
  })
  assert.equal(
    await session.requestURL('http://segments.evil.example/0.ts'),
    true,
  )
})

test('installRequestSSRFGuard allows requests the reason lookup clears', async () => {
  const session = guardWith({ 'https://cdn.example/0.ts': null })
  assert.equal(await session.requestURL('https://cdn.example/0.ts'), false)
})

test('installRequestSSRFGuard allows an explicitly allowed origin without consulting the reason lookup', async () => {
  // The dev server lives on loopback; it must stay reachable for the HLS
  // renderer page even though findBlockReason would otherwise flag it.
  const session = guardWith(
    { 'http://localhost:5173/src/renderer/playHLS.html': 'loopback host' },
    ['http://localhost:5173'],
  )
  assert.equal(
    await session.requestURL('http://localhost:5173/src/renderer/playHLS.html'),
    false,
  )
})

test('installRequestSSRFGuard allows a ws: request to the allow-listed dev server host', async () => {
  // The Vite HMR socket connects over ws: to the same host:port the dev
  // server's http: origin is allow-listed for; the allow-list must match by
  // host so this is not treated as a different, unlisted origin.
  const session = guardWith(
    { 'ws://localhost:5173/vite-hmr': 'loopback host' },
    ['http://localhost:5173'],
  )
  assert.equal(await session.requestURL('ws://localhost:5173/vite-hmr'), false)
})

test('installRequestSSRFGuard still blocks a ws: request to a different, non-allow-listed host', async () => {
  const session = guardWith(
    { 'ws://169.254.169.254/': 'blocking request to private-network address' },
    ['http://localhost:5173'],
  )
  assert.equal(await session.requestURL('ws://169.254.169.254/'), true)
})

test('installRequestSSRFGuard fails open if the reason lookup itself throws', async () => {
  const session = fakeSession()
  installRequestSSRFGuard(session, {
    findBlockReason: async () => {
      throw new Error('boom')
    },
  })
  assert.equal(
    await session.requestURL('https://cdn.example/0.ts'),
    false,
    'an internal guard error must not cancel legitimate traffic',
  )
})
