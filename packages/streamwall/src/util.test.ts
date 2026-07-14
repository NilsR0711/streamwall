import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  createSessionHostResolver,
  ensureValidURL,
  findRequestBlockReason,
} from './util'

// Deterministic resolver stubs so the DNS-dependent paths can be exercised
// without touching the network.
const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses
const resolveFails = async () => {
  throw new Error('ENOTFOUND')
}

test('allows a public https URL that resolves to a public address', async () => {
  await assert.doesNotReject(
    ensureValidURL('https://twitch.tv/streamer', resolvesTo('151.101.2.167')),
  )
})

test('allows an .m3u8 URL on a public host', async () => {
  await assert.doesNotReject(
    ensureValidURL(
      'https://cdn.example.com/live/index.m3u8',
      resolvesTo('93.184.216.34'),
    ),
  )
})

test('allows a public IP-literal URL', async () => {
  await assert.doesNotReject(ensureValidURL('http://8.8.8.8/stream'))
})

test('rejects a non-http(s) URL scheme', async () => {
  await assert.rejects(ensureValidURL('file:///etc/passwd'), /non-http/)
})

test('rejects a URL with no host', async () => {
  await assert.rejects(ensureValidURL('http:///path'), /host/)
})

test('rejects a malformed URL', async () => {
  await assert.rejects(ensureValidURL('not a valid url'))
})

test('rejects the loopback address', async () => {
  await assert.rejects(ensureValidURL('http://127.0.0.1/'), /private-network/)
})

test('rejects the localhost hostname (Streamdelay SSRF)', async () => {
  await assert.rejects(ensureValidURL('http://localhost:8404/'), /loopback/)
})

test('rejects a *.localhost hostname', async () => {
  await assert.rejects(ensureValidURL('http://admin.localhost/'), /loopback/)
})

test('rejects the cloud metadata endpoint (link-local range)', async () => {
  await assert.rejects(
    ensureValidURL('http://169.254.169.254/latest/meta-data/'),
    /private-network/,
  )
})

for (const url of [
  'http://10.0.0.5/',
  'http://192.168.1.10/',
  'http://172.16.0.1/',
  'http://100.64.0.1/',
  'http://0.0.0.0/',
]) {
  test(`rejects the private-range URL ${url}`, async () => {
    await assert.rejects(ensureValidURL(url), /private-network/)
  })
}

test('rejects an IPv6 loopback URL', async () => {
  await assert.rejects(ensureValidURL('http://[::1]/'), /private-network/)
})

test('rejects an IPv6 link-local URL', async () => {
  await assert.rejects(ensureValidURL('http://[fe80::1]/'), /private-network/)
})

test('rejects an IPv4-mapped IPv6 loopback URL', async () => {
  await assert.rejects(
    ensureValidURL('http://[::ffff:127.0.0.1]/'),
    /private-network/,
  )
})

test('rejects a decimal-encoded loopback URL', async () => {
  // new URL() normalises 2130706433 -> 127.0.0.1 before we ever see it.
  await assert.rejects(ensureValidURL('http://2130706433/'), /private-network/)
})

test('rejects a hex-encoded loopback URL', async () => {
  await assert.rejects(ensureValidURL('http://0x7f000001/'), /private-network/)
})

test('rejects a public hostname that resolves to a private address', async () => {
  await assert.rejects(
    ensureValidURL('http://stream.evil.example/', resolvesTo('10.1.2.3')),
    /private-network/,
  )
})

test('rejects a hostname when any resolved address is private', async () => {
  await assert.rejects(
    ensureValidURL(
      'http://mixed.example/',
      resolvesTo('93.184.216.34', '127.0.0.1'),
    ),
    /private-network/,
  )
})

test('rejects a hostname that resolves to a private IPv6 address', async () => {
  await assert.rejects(
    ensureValidURL('http://rebind.example/', resolvesTo('fc00::1234')),
    /private-network/,
  )
})

test('rejects a hostname that fails to resolve (fail closed)', async () => {
  await assert.rejects(
    ensureValidURL('http://nope.invalid/', resolveFails),
    /unresolvable/,
  )
})

test('rejects a hostname that resolves to no addresses', async () => {
  await assert.rejects(
    ensureValidURL('http://empty.example/', resolvesTo()),
    /unresolvable/,
  )
})

test('allows a public hostname that resolves to a public address', async () => {
  await assert.doesNotReject(
    ensureValidURL('http://stream.example.com/', resolvesTo('93.184.216.34')),
  )
})

// IPv4-embedded IPv6 transition forms that can deliver traffic to an internal
// IPv4 address (in addition to the IPv4-mapped ::ffff: form covered above).
test('rejects a NAT64-embedded link-local URL', async () => {
  await assert.rejects(
    ensureValidURL('http://[64:ff9b::169.254.169.254]/'),
    /private-network/,
  )
})

test('rejects a 6to4-embedded link-local URL', async () => {
  await assert.rejects(
    ensureValidURL('http://[2002:a9fe:a9fe::]/'),
    /private-network/,
  )
})

test('rejects a 6to4-embedded loopback URL', async () => {
  await assert.rejects(
    ensureValidURL('http://[2002:7f00:1::]/'),
    /private-network/,
  )
})

test('allows a public IPv6-literal URL', async () => {
  await assert.doesNotReject(ensureValidURL('http://[2606:4700:4700::1111]/'))
})

// A trailing FQDN dot must not slip past the loopback fast-path.
test('rejects the localhost hostname with a trailing dot', async () => {
  await assert.rejects(ensureValidURL('http://localhost./'), /loopback/)
})

test('rejects a *.localhost hostname with a trailing dot', async () => {
  await assert.rejects(ensureValidURL('http://admin.localhost./'), /loopback/)
})

// findRequestBlockReason is the network-layer counterpart of ensureValidURL:
// it is applied to *every* request a view's session issues (redirects and
// sub-resources included), returns a reason string when a request must be
// cancelled or null when it is allowed, and — unlike ensureValidURL — only
// governs http(s) and fails *open* on resolution failure (so a transient DNS
// hiccup on a legitimate public host does not cancel its traffic).

test('findRequestBlockReason allows a public host resolving to a public address', async () => {
  assert.equal(
    await findRequestBlockReason(
      'https://cdn.example/segment0.ts',
      resolvesTo('93.184.216.34'),
    ),
    null,
  )
})

test('findRequestBlockReason allows non-http requests (file/data/blob)', async () => {
  assert.equal(await findRequestBlockReason('file:///app/playHLS.html'), null)
  assert.equal(await findRequestBlockReason('data:text/plain,hi'), null)
  assert.equal(await findRequestBlockReason('blob:https://x/abc'), null)
})

test('findRequestBlockReason allows an unparseable URL', async () => {
  assert.equal(await findRequestBlockReason('::not a url::'), null)
})

test('findRequestBlockReason blocks the cloud-metadata literal address', async () => {
  const reason = await findRequestBlockReason(
    'http://169.254.169.254/latest/meta-data/',
  )
  assert.match(String(reason), /private-network/)
})

test('findRequestBlockReason blocks a literal loopback address', async () => {
  assert.match(
    String(await findRequestBlockReason('http://127.0.0.1/')),
    /private-network/,
  )
})

test('findRequestBlockReason blocks the localhost hostname', async () => {
  assert.match(
    String(await findRequestBlockReason('http://localhost:8404/')),
    /loopback/,
  )
})

test('findRequestBlockReason blocks a *.localhost hostname with a trailing dot', async () => {
  assert.match(
    String(await findRequestBlockReason('http://admin.localhost./')),
    /loopback/,
  )
})

test('findRequestBlockReason blocks a public host resolving to a private address', async () => {
  const reason = await findRequestBlockReason(
    'http://segments.evil.example/0.ts',
    resolvesTo('10.1.2.3'),
  )
  assert.match(String(reason), /private-network/)
})

test('findRequestBlockReason blocks when any resolved address is private', async () => {
  const reason = await findRequestBlockReason(
    'http://mixed.example/0.ts',
    resolvesTo('93.184.216.34', '169.254.169.254'),
  )
  assert.match(String(reason), /private-network/)
})

test('findRequestBlockReason blocks an IPv4-mapped IPv6 loopback literal', async () => {
  assert.match(
    String(await findRequestBlockReason('http://[::ffff:127.0.0.1]/0.ts')),
    /private-network/,
  )
})

test('findRequestBlockReason fails open when the host does not resolve', async () => {
  // Unlike ensureValidURL (fail-closed for the top-level load), the per-request
  // hook must not cancel a legitimate public sub-resource on a transient DNS
  // failure it cannot positively classify as private.
  assert.equal(
    await findRequestBlockReason('http://cdn.example/0.ts', resolveFails),
    null,
  )
})

test('findRequestBlockReason fails open when the host resolves to no addresses', async () => {
  assert.equal(
    await findRequestBlockReason('http://cdn.example/0.ts', resolvesTo()),
    null,
  )
})

test('findRequestBlockReason allows a public IPv6-literal request', async () => {
  assert.equal(
    await findRequestBlockReason('http://[2606:4700:4700::1111]/0.ts'),
    null,
  )
})

// A page loaded into a view can open a WebSocket from script (e.g.
// `new WebSocket('ws://169.254.169.254/')`), which is the same class of
// loopback/LAN/cloud-metadata SSRF as an http(s) sub-resource fetch. The
// guard must classify ws:/wss: targets the same way.

test('findRequestBlockReason blocks a ws: request to the cloud-metadata address', async () => {
  assert.match(
    String(
      await findRequestBlockReason('ws://169.254.169.254/latest/meta-data/'),
    ),
    /private-network/,
  )
})

test('findRequestBlockReason blocks a wss: request to a loopback hostname', async () => {
  assert.match(
    String(await findRequestBlockReason('wss://localhost:8404/')),
    /loopback/,
  )
})

test('findRequestBlockReason blocks a ws: request to a public host resolving to a private address', async () => {
  const reason = await findRequestBlockReason(
    'ws://ws.evil.example/socket',
    resolvesTo('10.1.2.3'),
  )
  assert.match(String(reason), /private-network/)
})

test('findRequestBlockReason allows a wss: request to a public host resolving to a public address', async () => {
  assert.equal(
    await findRequestBlockReason(
      'wss://ws.example.com/socket',
      resolvesTo('93.184.216.34'),
    ),
    null,
  )
})

test('findRequestBlockReason fails open for a ws: request when the host does not resolve', async () => {
  assert.equal(
    await findRequestBlockReason('ws://cdn.example/socket', resolveFails),
    null,
  )
})

// createSessionHostResolver adapts a session's own DNS resolver (the one
// Chromium actually uses to connect) into a HostAddressResolver, so
// ensureValidURL/findRequestBlockReason can be checked against the exact
// resolution the request will reuse — narrowing the DNS-rebinding
// time-of-check/time-of-use gap tracked in #169, instead of validating
// against a second, wholly independent lookup via Node's `dns.lookup`.

const fakeSessionResolving =
  (...endpoints: { address: string; family: 'ipv4' | 'ipv6' }[]) =>
  (): {
    resolveHost: (host: string) => Promise<{ endpoints: typeof endpoints }>
  } => ({
    resolveHost: async () => ({ endpoints }),
  })

test('createSessionHostResolver resolves a hostname via session.resolveHost', async () => {
  const calls: string[] = []
  const session = {
    resolveHost: async (host: string) => {
      calls.push(host)
      return {
        endpoints: [{ address: '93.184.216.34', family: 'ipv4' as const }],
      }
    },
  }
  const resolve = createSessionHostResolver(session)
  assert.deepEqual(await resolve('stream.example.com'), ['93.184.216.34'])
  assert.deepEqual(calls, ['stream.example.com'])
})

test('createSessionHostResolver flattens every resolved endpoint address', async () => {
  const session = fakeSessionResolving(
    { address: '93.184.216.34', family: 'ipv4' },
    { address: '2606:4700:4700::1111', family: 'ipv6' },
  )()
  const resolve = createSessionHostResolver(session)
  assert.deepEqual(await resolve('stream.example.com'), [
    '93.184.216.34',
    '2606:4700:4700::1111',
  ])
})

test('createSessionHostResolver resolves to an empty list when the session finds no endpoints', async () => {
  const resolve = createSessionHostResolver(fakeSessionResolving()())
  assert.deepEqual(await resolve('empty.example'), [])
})

test('ensureValidURL rejects a hostname the session resolver reports as private', async () => {
  const resolve = createSessionHostResolver(
    fakeSessionResolving({ address: '10.1.2.3', family: 'ipv4' })(),
  )
  await assert.rejects(
    ensureValidURL('http://rebind.example/', resolve),
    /private-network/,
  )
})

test('ensureValidURL allows a hostname the session resolver reports as public', async () => {
  const resolve = createSessionHostResolver(
    fakeSessionResolving({ address: '93.184.216.34', family: 'ipv4' })(),
  )
  await assert.doesNotReject(
    ensureValidURL('http://stream.example.com/', resolve),
  )
})

test('findRequestBlockReason blocks a sub-resource host the session resolver reports as private', async () => {
  const resolve = createSessionHostResolver(
    fakeSessionResolving({ address: '169.254.169.254', family: 'ipv4' })(),
  )
  const reason = await findRequestBlockReason(
    'http://metadata.evil.example/0.ts',
    resolve,
  )
  assert.match(String(reason), /private-network/)
})

test('findRequestBlockReason allows a sub-resource host the session resolver reports as public', async () => {
  const resolve = createSessionHostResolver(
    fakeSessionResolving({ address: '93.184.216.34', family: 'ipv4' })(),
  )
  assert.equal(
    await findRequestBlockReason('http://cdn.example/0.ts', resolve),
    null,
  )
})
