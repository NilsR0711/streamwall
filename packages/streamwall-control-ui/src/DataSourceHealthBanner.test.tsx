import { render } from 'preact'
import { act } from 'preact/test-utils'
import { type DataSourceHealth } from 'streamwall-shared'
import { afterEach, describe, expect, test } from 'vitest'
import { DataSourceHealthBanner } from './DataSourceHealthBanner.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderBanner(dataSourceHealth: DataSourceHealth[]): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <DataSourceHealthBanner dataSourceHealth={dataSourceHealth} />,
      container!,
    )
  })
  return container
}

describe('DataSourceHealthBanner', () => {
  test('renders nothing when there is no data source health yet', () => {
    const el = renderBanner([])
    expect(el.querySelector('.data-source-health-warning')).toBeNull()
  })

  test('renders nothing when every data source is healthy', () => {
    const el = renderBanner([
      {
        id: 'https://a.example/streams.json',
        type: 'json-url',
        status: 'ok',
        message: null,
        updatedAt: 1000,
      },
    ])
    expect(el.querySelector('.data-source-health-warning')).toBeNull()
  })

  test('warns about a failing json-url source, naming the URL', () => {
    const el = renderBanner([
      {
        id: 'https://dead.example/streams.json',
        type: 'json-url',
        status: 'error',
        message: 'fetch failed',
        updatedAt: 1000,
      },
    ])
    const warning = el.querySelector('.data-source-health-warning')
    expect(warning?.textContent).toContain('https://dead.example/streams.json')
    expect(warning?.getAttribute('title')).toBe('fetch failed')
  })

  test('warns about a failing toml-file source, naming the path', () => {
    const el = renderBanner([
      {
        id: '/etc/streamwall/streams.toml',
        type: 'toml-file',
        status: 'error',
        message: 'ENOENT',
        updatedAt: 1000,
      },
    ])
    expect(
      el.querySelector('.data-source-health-warning')?.textContent,
    ).toContain('/etc/streamwall/streams.toml')
  })

  test('lists a warning per failing source and ignores healthy ones', () => {
    const el = renderBanner([
      {
        id: 'https://a.example/streams.json',
        type: 'json-url',
        status: 'ok',
        message: null,
        updatedAt: 1000,
      },
      {
        id: 'https://b.example/streams.json',
        type: 'json-url',
        status: 'error',
        message: 'timeout',
        updatedAt: 1000,
      },
      {
        id: '/tmp/streams.toml',
        type: 'toml-file',
        status: 'error',
        message: 'ENOENT',
        updatedAt: 1000,
      },
    ])
    const warnings = [
      ...el.querySelectorAll('.data-source-health-warning'),
    ].map((w) => w.textContent)
    expect(warnings).toHaveLength(2)
    expect(warnings.join(' ')).toContain('https://b.example/streams.json')
    expect(warnings.join(' ')).toContain('/tmp/streams.toml')
  })

  // A data-source outage is recoverable and not user-triggered, so it is
  // announced politely rather than interrupting the operator (WCAG 4.1.3,
  // issue #398).
  test('announces failing sources politely to assistive technology', () => {
    const el = renderBanner([
      {
        id: 'https://dead.example/streams.json',
        type: 'json-url',
        status: 'error',
        message: 'fetch failed',
        updatedAt: 1000,
      },
    ])
    const banner = el.querySelector('[role="status"]')
    expect(banner).not.toBeNull()
    expect(banner?.getAttribute('aria-live')).toBe('polite')
  })
})
