import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  createUpdateChecker,
  isUpdateCheckEnabled,
  SERVER_VERSION,
} from './updateCheck.ts'

/** A `fetch`-shaped stub resolving to a JSON body with the given status. */
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('SERVER_VERSION', () => {
  test('reports the control-server package version', () => {
    assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+/)
  })
})

describe('isUpdateCheckEnabled', () => {
  test('defaults to enabled when unset or empty', () => {
    assert.equal(isUpdateCheckEnabled(undefined), true)
    assert.equal(isUpdateCheckEnabled(''), true)
  })

  test('is disabled by the documented off values', () => {
    for (const raw of ['false', 'FALSE', '0', 'no', 'off', ' off ']) {
      assert.equal(
        isUpdateCheckEnabled(raw),
        false,
        `expected ${raw} to disable`,
      )
    }
  })

  test('stays enabled for explicit on values', () => {
    for (const raw of ['true', '1', 'yes', 'on']) {
      assert.equal(isUpdateCheckEnabled(raw), true, `expected ${raw} to enable`)
    }
  })
})

describe('createUpdateChecker', () => {
  test('reports the running version and no update before the first check', () => {
    const checker = createUpdateChecker({
      currentVersion: '0.9.1',
      fetchImpl: async () => jsonResponse({}),
    })

    assert.deepEqual(checker.getStatus(), {
      version: '0.9.1',
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      lastCheckedAt: null,
      checkEnabled: true,
    })
  })

  test('flags an available update after a check', async () => {
    const checker = createUpdateChecker({
      currentVersion: '0.9.1',
      fetchImpl: async () =>
        jsonResponse({
          tag_name: 'v1.0.0',
          html_url: 'https://example.test/releases/v1.0.0',
        }),
    })

    const status = await checker.checkNow()

    assert.equal(status.latestVersion, '1.0.0')
    assert.equal(status.updateAvailable, true)
    assert.equal(status.releaseUrl, 'https://example.test/releases/v1.0.0')
    assert.match(status.lastCheckedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(checker.getStatus(), status)
  })

  test('reports no update when the latest release is the running version', async () => {
    const checker = createUpdateChecker({
      currentVersion: '1.0.0',
      fetchImpl: async () =>
        jsonResponse({
          tag_name: 'v1.0.0',
          html_url: 'https://example.test/r',
        }),
    })

    const status = await checker.checkNow()

    assert.equal(status.latestVersion, '1.0.0')
    assert.equal(status.updateAvailable, false)
  })

  test('logs once per newly discovered version, not on every check', async () => {
    const logged: string[] = []
    const checker = createUpdateChecker({
      currentVersion: '0.9.1',
      log: (msg) => logged.push(msg),
      fetchImpl: async () =>
        jsonResponse({
          tag_name: 'v1.0.0',
          html_url: 'https://example.test/r',
        }),
    })

    await checker.checkNow()
    await checker.checkNow()

    assert.equal(logged.length, 1)
    assert.match(logged[0], /1\.0\.0/)
  })

  test('keeps the last known result when a check fails', async () => {
    let failNext = false
    const checker = createUpdateChecker({
      currentVersion: '0.9.1',
      fetchImpl: async () => {
        if (failNext) {
          throw new Error('network down')
        }
        return jsonResponse({
          tag_name: 'v1.0.0',
          html_url: 'https://example.test/r',
        })
      },
    })

    const first = await checker.checkNow()
    failNext = true
    const second = await checker.checkNow()

    assert.equal(second.latestVersion, '1.0.0')
    assert.equal(second.updateAvailable, true)
    assert.equal(second.lastCheckedAt, first.lastCheckedAt)
  })

  test('never performs a request when disabled', async () => {
    let calls = 0
    const checker = createUpdateChecker({
      currentVersion: '0.9.1',
      enabled: false,
      fetchImpl: async () => {
        calls++
        return jsonResponse({ tag_name: 'v1.0.0', html_url: 'https://x.test' })
      },
    })

    const status = await checker.checkNow()

    assert.equal(calls, 0)
    assert.equal(status.checkEnabled, false)
    assert.equal(status.latestVersion, null)
    assert.equal(status.updateAvailable, false)
  })

  test('start() schedules periodic checks and stop() clears them', async () => {
    let calls = 0
    const timers: { fn: () => void; ms: number }[] = []
    const checker = createUpdateChecker({
      currentVersion: '0.9.1',
      intervalMs: 1000,
      fetchImpl: async () => {
        calls++
        return jsonResponse({ tag_name: 'v0.9.1', html_url: 'https://x.test' })
      },
      setIntervalImpl: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length
      },
      clearIntervalImpl: (handle) => {
        timers.splice(Number(handle) - 1, 1)
      },
    })

    await checker.start()

    assert.equal(calls, 1, 'start() runs an immediate check')
    assert.equal(timers.length, 1)
    assert.equal(timers[0].ms, 1000)

    checker.stop()
    assert.equal(timers.length, 0)
  })

  test('start() is idempotent (no duplicate intervals)', async () => {
    const timers: unknown[] = []
    const checker = createUpdateChecker({
      currentVersion: '0.9.1',
      fetchImpl: async () =>
        jsonResponse({ tag_name: 'v0.9.1', html_url: 'https://x.test' }),
      setIntervalImpl: () => {
        timers.push({})
        return timers.length
      },
      clearIntervalImpl: () => {
        timers.pop()
      },
    })

    await checker.start()
    await checker.start()

    assert.equal(timers.length, 1)
    checker.stop()
  })

  test('start() does not schedule anything when disabled', async () => {
    let scheduled = 0
    const checker = createUpdateChecker({
      currentVersion: '0.9.1',
      enabled: false,
      fetchImpl: async () => jsonResponse({}),
      setIntervalImpl: () => {
        scheduled++
        return scheduled
      },
      clearIntervalImpl: () => {},
    })

    await checker.start()

    assert.equal(scheduled, 0)
  })
})
