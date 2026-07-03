import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  parseBearerCredential,
  resolveControlConnection,
} from 'streamwall-shared'

describe('parseBearerCredential', () => {
  test('parses a well-formed bearer credential', () => {
    assert.deepEqual(parseBearerCredential('Bearer abc123:s3cr3t'), {
      tokenId: 'abc123',
      secret: 's3cr3t',
    })
  })

  test('accepts a case-insensitive scheme and surrounding whitespace', () => {
    assert.deepEqual(parseBearerCredential('  bearer   abc:def '), {
      tokenId: 'abc',
      secret: 'def',
    })
  })

  test('rejects malformed or empty values', () => {
    assert.equal(parseBearerCredential(undefined), null)
    assert.equal(parseBearerCredential(null), null)
    assert.equal(parseBearerCredential(''), null)
    assert.equal(parseBearerCredential('Bearer'), null)
    assert.equal(parseBearerCredential('Bearer nocolon'), null)
    assert.equal(parseBearerCredential('Bearer :onlysecret'), null)
    assert.equal(parseBearerCredential('Bearer onlyid:'), null)
    assert.equal(parseBearerCredential('Basic abc:def'), null)
  })
})

describe('resolveControlConnection', () => {
  test('passes through the modern endpoint + token form', () => {
    assert.deepEqual(
      resolveControlConnection({
        endpoint: 'ws://host:3000/streamwall/ws',
        token: 'id123:secret456',
      }),
      {
        endpoint: 'ws://host:3000/streamwall/ws',
        credential: 'id123:secret456',
        legacy: false,
      },
    )
  })

  test('migrates a deprecated token-in-URL endpoint', () => {
    const resolved = resolveControlConnection({
      endpoint: 'ws://host:3000/streamwall/ID123/ws?token=SECRET456',
    })
    assert.equal(resolved?.legacy, true)
    assert.equal(resolved?.endpoint, 'ws://host:3000/streamwall/ws')
    assert.equal(resolved?.credential, 'ID123:SECRET456')
  })

  test('returns null when there is no usable credential', () => {
    assert.equal(resolveControlConnection({ endpoint: null }), null)
    assert.equal(resolveControlConnection({ endpoint: '' }), null)
    assert.equal(
      resolveControlConnection({ endpoint: 'ws://host/streamwall/ws' }),
      null,
    )
  })
})
