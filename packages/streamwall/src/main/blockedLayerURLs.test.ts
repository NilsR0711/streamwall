import {
  MAX_BLOCKED_LAYER_URL_LENGTH,
  MAX_BLOCKED_LAYER_URLS,
  type StreamData,
} from 'streamwall-shared'
import { describe, expect, it } from 'vitest'
import { BlockedLayerURLTracker } from './blockedLayerURLs'

function layers(...links: string[]): StreamData[] {
  return links.map((link, i) => ({
    _id: `id-${i}`,
    _dataSource: 'test',
    link,
    kind: 'overlay' as const,
  }))
}

describe('BlockedLayerURLTracker', () => {
  // The returned list is stored as the broadcast state, so handing out the
  // tracker's own array would tie an already-sent state to whatever happens to
  // it next.
  it('hands out a list of its own', () => {
    const tracker = new BlockedLayerURLTracker()
    const first = tracker.report('http://192.168.1.5/a')!

    first.push('http://192.168.1.5/not-refused')

    expect(tracker.report('http://192.168.1.5/b')).toEqual([
      'http://192.168.1.5/a',
      'http://192.168.1.5/b',
    ])
  })

  it('collects refused URLs in the order they were reported', () => {
    const tracker = new BlockedLayerURLTracker()

    expect(tracker.report('http://192.168.1.5/a')).toEqual([
      'http://192.168.1.5/a',
    ])
    expect(tracker.report('http://192.168.1.5/b')).toEqual([
      'http://192.168.1.5/a',
      'http://192.168.1.5/b',
    ])
  })

  // A layer page polling a refused endpoint would otherwise re-broadcast the
  // whole state at request rate.
  it('reports no change for a URL it already holds', () => {
    const tracker = new BlockedLayerURLTracker()
    tracker.report('http://192.168.1.5/a')

    expect(tracker.report('http://192.168.1.5/a')).toBeNull()
  })

  it('truncates a URL to the bound the state schema enforces', () => {
    const tracker = new BlockedLayerURLTracker()

    const urls = tracker.report(
      `http://192.168.1.5/${'x'.repeat(MAX_BLOCKED_LAYER_URL_LENGTH)}`,
    )

    expect(urls).toHaveLength(1)
    expect(urls![0]).toHaveLength(MAX_BLOCKED_LAYER_URL_LENGTH)
    expect(urls![0]).toMatch(/…$/)
  })

  // Two addresses that differ only past the cut are the same entry to anybody
  // reading the notice, and listing them twice would spend a slot to say
  // nothing.
  it('holds one entry for URLs that differ only past the cut', () => {
    const tracker = new BlockedLayerURLTracker()
    const prefix = `http://192.168.1.5/${'x'.repeat(MAX_BLOCKED_LAYER_URL_LENGTH)}`

    tracker.report(`${prefix}a`)

    expect(tracker.report(`${prefix}b`)).toBeNull()
  })

  it('leaves a URL at exactly the bound alone', () => {
    const tracker = new BlockedLayerURLTracker()
    const url = 'x'.repeat(MAX_BLOCKED_LAYER_URL_LENGTH)

    expect(tracker.report(url)).toEqual([url])
  })

  // The framed page decides what gets requested, so a full list drops the
  // newcomer rather than the operator's own refused link.
  it("caps the list and keeps the operator's first report", () => {
    const tracker = new BlockedLayerURLTracker()
    let urls: readonly string[] =
      tracker.report('http://192.168.1.5/the-operators-link') ?? []
    for (let i = 0; i < 100; i++) {
      urls = tracker.report(`http://192.168.1.5/?churn=${i}`) ?? urls
    }

    expect(tracker.report('http://192.168.1.5/one-more')).toBeNull()
    expect(urls).toContain('http://192.168.1.5/the-operators-link')
    expect(urls).not.toContain('http://192.168.1.5/one-more')
  })

  it('never grows past the broadcast cap', () => {
    const tracker = new BlockedLayerURLTracker()
    let urls: readonly string[] = []
    for (let i = 0; i < 100; i++) {
      urls = tracker.report(`http://192.168.1.5/${i}`) ?? urls
    }

    expect(urls).toHaveLength(MAX_BLOCKED_LAYER_URLS)
    expect(urls[0]).toBe('http://192.168.1.5/0')
  })

  describe('syncLayerLinks', () => {
    it('does not clear when it learns the layer links for the first time', () => {
      const tracker = new BlockedLayerURLTracker()
      tracker.report('http://192.168.1.5/a')

      expect(tracker.syncLayerLinks(layers('https://example.com/o'))).toBeNull()
    })

    it('clears the list once the operator edits a layer link', () => {
      const tracker = new BlockedLayerURLTracker()
      tracker.syncLayerLinks(layers('https://example.com/o'))
      tracker.report('http://192.168.1.5/a')

      expect(
        tracker.syncLayerLinks(layers('https://example.com/fixed')),
      ).toEqual([])
    })

    it('reports no change while the layer links stand still', () => {
      const tracker = new BlockedLayerURLTracker()
      tracker.syncLayerLinks(layers('https://example.com/o'))
      tracker.report('http://192.168.1.5/a')

      expect(tracker.syncLayerLinks(layers('https://example.com/o'))).toBeNull()
    })

    it('reports no change when an edit clears an already empty list', () => {
      const tracker = new BlockedLayerURLTracker()
      tracker.syncLayerLinks(layers('https://example.com/o'))

      expect(
        tracker.syncLayerLinks(layers('https://example.com/other')),
      ).toBeNull()
    })

    // Only the layer links matter: a stream view's link changes constantly and
    // has nothing to do with what the layer sessions refused.
    it('ignores changes to non-layer streams', () => {
      const tracker = new BlockedLayerURLTracker()
      const overlay = layers('https://example.com/o')
      const video: StreamData = {
        _id: 'v',
        _dataSource: 'test',
        link: 'https://example.com/v1',
        kind: 'video',
      }
      tracker.syncLayerLinks([...overlay, video])
      tracker.report('http://192.168.1.5/a')

      expect(
        tracker.syncLayerLinks([
          ...overlay,
          { ...video, link: 'https://example.com/v2' },
        ]),
      ).toBeNull()
    })

    // Issue #810: a control client that was disconnected across the clear
    // reconnects to a snapshot that can name the same address again, which
    // membership alone cannot tell apart from the address never having gone
    // away. The generation is the marker that says a clear happened.
    it('starts at generation zero', () => {
      expect(new BlockedLayerURLTracker().generation).toBe(0)
    })

    it('bumps the generation when an edit clears the list', () => {
      const tracker = new BlockedLayerURLTracker()
      tracker.syncLayerLinks(layers('https://example.com/o'))
      tracker.report('http://192.168.1.5/a')

      tracker.syncLayerLinks(layers('https://example.com/fixed'))

      expect(tracker.generation).toBe(1)
    })

    it('bumps the generation once per clear', () => {
      const tracker = new BlockedLayerURLTracker()
      tracker.syncLayerLinks(layers('https://example.com/o'))
      tracker.report('http://192.168.1.5/a')
      tracker.syncLayerLinks(layers('https://example.com/second'))
      tracker.report('http://192.168.1.5/a')
      tracker.syncLayerLinks(layers('https://example.com/third'))

      expect(tracker.generation).toBe(2)
    })

    it('leaves the generation alone while the layer links stand still', () => {
      const tracker = new BlockedLayerURLTracker()
      tracker.syncLayerLinks(layers('https://example.com/o'))
      tracker.report('http://192.168.1.5/a')

      tracker.syncLayerLinks(layers('https://example.com/o'))

      expect(tracker.generation).toBe(0)
    })

    it('leaves the generation alone when it learns the links for the first time', () => {
      const tracker = new BlockedLayerURLTracker()
      tracker.report('http://192.168.1.5/a')

      tracker.syncLayerLinks(layers('https://example.com/o'))

      expect(tracker.generation).toBe(0)
    })

    // Nothing was cleared, so no dismissal can be pointing at a list that no
    // longer stands: a dismissal only ever names an address the desktop was
    // reporting, and an empty list was reporting none.
    it('leaves the generation alone when an edit clears an empty list', () => {
      const tracker = new BlockedLayerURLTracker()
      tracker.syncLayerLinks(layers('https://example.com/o'))

      tracker.syncLayerLinks(layers('https://example.com/other'))

      expect(tracker.generation).toBe(0)
    })

    it('leaves the generation alone while collecting reports', () => {
      const tracker = new BlockedLayerURLTracker()
      tracker.syncLayerLinks(layers('https://example.com/o'))

      tracker.report('http://192.168.1.5/a')
      tracker.report('http://192.168.1.5/b')

      expect(tracker.generation).toBe(0)
    })

    it('re-collects reports after an edit cleared them', () => {
      const tracker = new BlockedLayerURLTracker()
      tracker.syncLayerLinks(layers('https://example.com/o'))
      tracker.report('http://192.168.1.5/a')
      tracker.syncLayerLinks(layers('https://example.com/fixed'))

      expect(tracker.report('http://192.168.1.5/a')).toEqual([
        'http://192.168.1.5/a',
      ])
    })
  })
})
