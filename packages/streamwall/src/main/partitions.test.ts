import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  allocateLayerPartition,
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

// Electron's synchronous counterpart: it returns the answer rather than
// calling back, and is consulted for checks that raise no prompt.
type PermissionCheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
) => boolean

function fakeSession() {
  let handler: PermissionHandler | null = null
  let checkHandler: PermissionCheckHandler | null = null
  let requestListener: RequestListener | null = null
  return {
    setPermissionRequestHandler(next: PermissionHandler | null) {
      handler = next
    },
    setPermissionCheckHandler(next: PermissionCheckHandler | null) {
      checkHandler = next
    },
    webRequest: {
      onBeforeRequest(listener: RequestListener) {
        requestListener = listener
      },
    },
    // Overridable per test; the default reports every hostname as public so
    // tests that don't care about DNS classification aren't forced to stub it.
    resolveHost: async (
      _host: string,
    ): Promise<{
      endpoints: { address: string; family: 'ipv4' | 'ipv6' }[]
    }> => ({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] }),
    check(permission: string): boolean {
      assert.ok(checkHandler, 'a permission check handler must be registered')
      return checkHandler({}, permission, 'https://example.com')
    },
    hasCheckHandler(): boolean {
      return checkHandler !== null
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

test('allocateLayerPartition returns a unique ephemeral partition on every call', () => {
  // The chrome layers embed operator-supplied overlay/background URLs in
  // iframes, so they need the same isolation a stream view gets rather than the
  // app's shared, on-disk default session (#733).
  const seen = new Set<string>()
  for (let i = 0; i < 100; i++) {
    const partition = allocateLayerPartition()
    assert.ok(partition.startsWith('layer-'), 'layer partitions are prefixed')
    assert.ok(
      !partition.startsWith('persist:'),
      'layer partitions are ephemeral',
    )
    assert.ok(!seen.has(partition), `partition ${partition} must be unique`)
    seen.add(partition)
  }
})

test('layer partitions do not collide with the stream-view or browse namespaces', () => {
  const partition = allocateLayerPartition()
  assert.ok(
    !partition.startsWith('view-'),
    'a layer must not land in a stream view session',
  )
  assert.notEqual(partition, BROWSE_PARTITION)
})

test('hardenSession registers a permission request handler', () => {
  const session = fakeSession()
  let registered = false
  const original = session.setPermissionRequestHandler
  session.setPermissionRequestHandler = (handler) => {
    registered = true
    original(handler)
  }
  hardenSession(session as unknown as Parameters<typeof hardenSession>[0])
  assert.ok(registered, 'hardenSession must register a permission handler')
})

test('hardened session rejects every permission request', () => {
  const session = fakeSession()
  hardenSession(session as unknown as Parameters<typeof hardenSession>[0])
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
  hardenSession(session as unknown as Parameters<typeof hardenSession>[0])
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

// The default resolver (i.e. when findBlockReason is not overridden) must be
// the guarded session's own resolveHost, not an independent DNS lookup — this
// is what narrows the #169 DNS-rebinding time-of-check/time-of-use gap by
// sharing the resolver and cache Chromium actually connects through.

test("installRequestSSRFGuard defaults to the guarded session's own resolveHost", async () => {
  const session = fakeSession()
  const calls: string[] = []
  session.resolveHost = async (host: string) => {
    calls.push(host)
    return { endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] }
  }
  installRequestSSRFGuard(session)
  assert.equal(await session.requestURL('http://stream.example/0.ts'), false)
  assert.deepEqual(calls, ['stream.example'])
})

test('installRequestSSRFGuard blocks a request when the session resolver reports a private address', async () => {
  const session = fakeSession()
  session.resolveHost = async () => ({
    endpoints: [{ address: '10.1.2.3', family: 'ipv4' }],
  })
  installRequestSSRFGuard(session)
  assert.equal(
    await session.requestURL('http://rebind.evil.example/0.ts'),
    true,
  )
})

test('installRequestSSRFGuard reports a blocked request to the caller', async () => {
  // The guard's cancellation is otherwise invisible to the surface that asked
  // for the URL, which leaves an operator staring at a blank layer (#790).
  const blocked: Array<[string, string]> = []
  const session = fakeSession()
  installRequestSSRFGuard(session, {
    findBlockReason: async (url) =>
      url === 'http://192.168.1.50/overlay'
        ? 'blocking request to private-network address'
        : null,
    onBlocked: (url, reason) => blocked.push([url, reason]),
  })

  await session.requestURL('http://192.168.1.50/overlay')
  await session.requestURL('https://cdn.example/overlay')

  assert.deepEqual(blocked, [
    [
      'http://192.168.1.50/overlay',
      'blocking request to private-network address',
    ],
  ])
})

test('installRequestSSRFGuard survives a reporter that throws', async () => {
  // A failing reporter must not turn into a fail-open for the request itself.
  const session = fakeSession()
  installRequestSSRFGuard(session, {
    findBlockReason: async () => 'blocking request to private-network address',
    onBlocked: () => {
      throw new Error('reporter exploded')
    },
  })

  assert.equal(await session.requestURL('http://192.168.1.50/overlay'), true)
})

test('hardenSession passes the blocked-request reporter through', async () => {
  const blocked: string[] = []
  const session = fakeSession()
  hardenSession(session as unknown as Parameters<typeof hardenSession>[0], {
    onBlocked: (url) => blocked.push(url),
  })

  await session.requestURL('http://169.254.169.254/latest/meta-data/')

  assert.deepEqual(blocked, ['http://169.254.169.254/latest/meta-data/'])
})

// The request handler covers the prompt path; Chromium consults the check
// handler on its own for `navigator.permissions.query`, device enumeration and
// other capability probes that never raise a prompt (#789).
test('hardenSession registers a permission check handler', () => {
  const session = fakeSession()
  hardenSession(session as unknown as Parameters<typeof hardenSession>[0])
  assert.ok(
    session.hasCheckHandler(),
    'hardenSession must register a permission check handler',
  )
})

test('hardened session answers no to every permission check', () => {
  // Electron's `setPermissionCheckHandler` union, which is not the request
  // handler's: `hid`, `serial`, `usb` and `deprecated-sync-clipboard-read` are
  // check-only, while `display-capture`, `keyboardLock`, `speaker-selection`
  // and `window-management` are request-only.
  const session = fakeSession()
  hardenSession(session as unknown as Parameters<typeof hardenSession>[0])
  for (const permission of [
    'media',
    'mediaKeySystem',
    'geolocation',
    'notifications',
    'midi',
    'midiSysex',
    'clipboard-read',
    'clipboard-sanitized-write',
    'deprecated-sync-clipboard-read',
    'fileSystem',
    'fullscreen',
    'openExternal',
    'serial',
    'hid',
    'usb',
    'idle-detection',
    'storage-access',
    'top-level-storage-access',
    'pointerLock',
  ]) {
    assert.equal(
      session.check(permission),
      false,
      `permission check "${permission}" must be denied`,
    )
  }
})
