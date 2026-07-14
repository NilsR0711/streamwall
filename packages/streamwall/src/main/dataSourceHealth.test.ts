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

  test('updates an existing entry in place rather than duplicating it', () => {
    const tracker = new DataSourceHealthTracker(() => 1000)
    tracker.report('url', 'json-url', true)

    const result = tracker.report('url', 'json-url', false, 'boom')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'url', status: 'error' })
  })
})
