import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../../..')

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

describe('self-host deploy stack contract', () => {
  test('docker-compose enables trustProxy for the control server behind Caddy', () => {
    const compose = readRepoFile('deploy/docker-compose.yml')
    assert.match(
      compose,
      /STREAMWALL_TRUST_PROXY:\s*['"]?true['"]?/,
      'control-server must trust the reverse proxy so per-IP rate limits use client IPs',
    )
  })

  test('.env.example documents trustProxy for the Caddy stack', () => {
    const envExample = readRepoFile('deploy/.env.example')
    assert.match(envExample, /STREAMWALL_TRUST_PROXY/)
    assert.doesNotMatch(
      envExample,
      /does not fill in the scheme's conventional port/i,
      'port-default fix (#371) should remove the old workaround wording',
    )
  })

  test('self-hosting guide documents per-client rate limits behind Caddy', () => {
    const guide = readRepoFile('docs/self-hosting.md')
    assert.match(guide, /STREAMWALL_TRUST_PROXY/)
    assert.doesNotMatch(
      guide,
      /Known limitation:.*X-Forwarded-For/s,
      'trustProxy fix (#372) should remove the reverse-proxy rate-limit caveat',
    )
    assert.doesNotMatch(
      guide,
      /does not fill in port 443/i,
      'port-default fix (#371) should remove the explicit-port workaround note',
    )
  })
})
