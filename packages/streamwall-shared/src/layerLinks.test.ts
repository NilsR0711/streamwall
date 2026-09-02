import { describe, expect, test } from 'vitest'
import { layerLinksKey } from './layerLinks.ts'
import type { StreamData } from './types.ts'

const stream = (kind: StreamData['kind'], link: string): StreamData => ({
  _id: link,
  _dataSource: 'custom',
  kind,
  link,
})

describe('layerLinksKey', () => {
  test('covers both layers and ignores everything else', () => {
    const key = layerLinksKey([
      stream('overlay', 'https://a.example'),
      stream('video', 'https://ignored.example'),
      stream('background', 'https://b.example'),
    ])

    expect(key).toContain('https://a.example')
    expect(key).toContain('https://b.example')
    expect(key).not.toContain('ignored')
  })

  test('changes when a layer link is edited', () => {
    expect(layerLinksKey([stream('overlay', 'https://a.example')])).not.toBe(
      layerLinksKey([stream('overlay', 'https://b.example')]),
    )
  })

  // Layer streams can come from a polled data source, which is free to return
  // the same links in a different order. Reading that as an operator edit
  // would clear a blocked-URL notice nobody asked to clear, and re-fill it on
  // the next poll.
  test('does not change when the same links arrive in another order', () => {
    expect(
      layerLinksKey([
        stream('overlay', 'https://a.example'),
        stream('background', 'https://b.example'),
      ]),
    ).toBe(
      layerLinksKey([
        stream('background', 'https://b.example'),
        stream('overlay', 'https://a.example'),
      ]),
    )
  })

  // Nothing bounds the characters in a link, so two different link sets must
  // not be able to collide by embedding the separator.
  test('distinguishes link sets that embed a separator', () => {
    expect(
      layerLinksKey([
        stream('overlay', 'https://a.example\nhttps://b.example'),
      ]),
    ).not.toBe(
      layerLinksKey([
        stream('overlay', 'https://a.example'),
        stream('background', 'https://b.example'),
      ]),
    )
  })
})
