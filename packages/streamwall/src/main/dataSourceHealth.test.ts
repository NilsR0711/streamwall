import { MAX_DATA_SOURCE_MESSAGE_LENGTH } from 'streamwall-shared'
import { describe, expect, test } from 'vitest'
import { DataSourceHealthTracker } from './dataSourceHealth'

describe('DataSourceHealthTracker', () => {
  test('reports a healthy source', () => {
    const tracker = new DataSourceHealthTracker(() => 1000)

    const result = tracker.report(
      'https://a.example/streams.json',
      'json-url',
      true,
    )

    expect(result).toEqual([
      {
        id: 'https://a.example/streams.json',
        type: 'json-url',
        status: 'ok',
        message: null,
        updatedAt: 1000,
      },
    ])
  })

  test('reports an unhealthy source with its message', () => {
    const tracker = new DataSourceHealthTracker(() => 1000)

    const result = tracker.report(
      '/tmp/streams.toml',
      'toml-file',
      false,
      'ENOENT: no such file',
    )

    expect(result).toEqual([
      {
        id: '/tmp/streams.toml',
        type: 'toml-file',
        status: 'error',
        message: 'ENOENT: no such file',
        updatedAt: 1000,
      },
    ])
  })

  test('drops the message when a source recovers', () => {
    const tracker = new DataSourceHealthTracker(() => 1000)
    tracker.report('url', 'json-url', false, 'boom')

    const result = tracker.report('url', 'json-url', true)

    expect(result).toEqual([
      {
        id: 'url',
        type: 'json-url',
        status: 'ok',
        message: null,
        updatedAt: 1000,
      },
    ])
  })

  test('tracks multiple sources independently, keyed by id', () => {
    const tracker = new DataSourceHealthTracker(() => 1000)
    tracker.report('url-a', 'json-url', true)

    const result = tracker.report('url-b', 'toml-file', false, 'boom')

    expect(result.map((h) => h.id)).toEqual(['url-a', 'url-b'])
  })

  // Issue #817: a data source's message forwards whatever the polled
  // endpoint said back, entirely under that endpoint's control, and flows
  // unbounded into the broadcast state -- the same denial-of-service vector
  // #734 fixed for `document.title`. Truncated at the producer, mirroring
  // `formatError` for view errors, so the server-side schema bound is a
  // backstop rather than the only thing standing between a hostile source
  // and an oversized state frame.
  test('truncates a message longer than the allowed length', () => {
    const tracker = new DataSourceHealthTracker(() => 1000)
    const oversized = 'x'.repeat(MAX_DATA_SOURCE_MESSAGE_LENGTH + 500)

    const result = tracker.report('url', 'json-url', false, oversized)

    expect(result[0].message).toBe('x'.repeat(MAX_DATA_SOURCE_MESSAGE_LENGTH))
  })

  test('does not truncate a message at exactly the allowed length', () => {
    const tracker = new DataSourceHealthTracker(() => 1000)
    const atLimit = 'x'.repeat(MAX_DATA_SOURCE_MESSAGE_LENGTH)

    const result = tracker.report('url', 'json-url', false, atLimit)

    expect(result[0].message).toBe(atLimit)
  })

  test('updates an existing entry in place rather than duplicating it', () => {
    const tracker = new DataSourceHealthTracker(() => 1000)
    tracker.report('url', 'json-url', true)

    const result = tracker.report('url', 'json-url', false, 'boom')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'url', status: 'error' })
  })
})
