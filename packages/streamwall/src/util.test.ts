import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ensureValidURL } from './util.ts'

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
