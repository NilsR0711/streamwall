import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadStorage } from './storage.ts'

function withTempStorage(contents: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), 'swcs-storage-'))
  const file = path.join(dir, 'storage.json')
  writeFileSync(file, JSON.stringify(contents))
  return {
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('loadStorage strips a legacy plaintext uplink secret from memory and disk', async () => {
  const { file, cleanup } = withTempStorage({
    auth: { salt: 'abc', tokens: [] },
    streamwallToken: { tokenId: 'sw-token-id', secret: 'PLAINTEXT-SECRET' },
  })
  try {
    const db = await loadStorage(file)

    // In memory: only the tokenId reference remains.
    assert.deepEqual(db.data.streamwallToken, { tokenId: 'sw-token-id' })

    // On disk: the plaintext secret has been rewritten away.
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(onDisk.streamwallToken, { tokenId: 'sw-token-id' })
    assert.ok(
      !readFileSync(file, 'utf8').includes('PLAINTEXT-SECRET'),
      'plaintext secret still present on disk',
    )
  } finally {
    cleanup()
  }
})

test('loadStorage leaves a hash-only uplink reference untouched', async () => {
  const { file, cleanup } = withTempStorage({
    auth: { salt: 'abc', tokens: [] },
    streamwallToken: { tokenId: 'sw-token-id' },
  })
  try {
    const db = await loadStorage(file)
    assert.deepEqual(db.data.streamwallToken, { tokenId: 'sw-token-id' })
  } finally {
    cleanup()
  }
})
