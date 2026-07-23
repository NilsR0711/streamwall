import type { StreamDataContent } from 'streamwall-shared'
import { describe, expect, test, vi } from 'vitest'
import log from '../logger'
import { parseStreamEntries, StreamIDGenerator } from './parse'

describe('parseStreamEntries', () => {
  test('keeps the valid entries and warns about the rejected ones', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const streams = parseStreamEntries(
        [{ link: 'https://a.example/s', kind: 'video' }, { kind: 'audio' }],
        'from https://feed.example/',
      )
      expect(streams.map((s) => s.link)).toEqual(['https://a.example/s'])
      expect(warnSpy).toHaveBeenCalledWith(
        'ignoring 1 invalid stream(s) from https://feed.example/',
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('does not warn when every entry is valid', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const streams = parseStreamEntries(
        [{ link: 'https://a.example/s', kind: 'video' }],
        'in /tmp/streams.toml',
      )
      expect(streams).toHaveLength(1)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('StreamIDGenerator', () => {
  function stream(
    overrides: Partial<StreamDataContent> & { link: string },
  ): StreamDataContent {
    return { kind: 'video', ...overrides }
  }

  test('derives a 3-character id from the source/label/link', () => {
    const gen = new StreamIDGenerator()
    const streams = [
      stream({ link: 'https://a.example/s', source: 'Example Source' }),
    ]
    gen.process(streams)
    expect(streams[0]._id).toBe('exa')
  })

  test('resolves collisions with an incrementing numeric suffix', () => {
    const gen = new StreamIDGenerator()
    const streams = [
      stream({ link: 'https://a.example/s', source: 'Example' }),
      stream({ link: 'https://b.example/s', source: 'Example' }),
      stream({ link: 'https://c.example/s', source: 'Example' }),
    ]
    gen.process(streams)
    expect(streams.map((s) => s._id)).toEqual(['exa', 'exa1', 'exa2'])
  })

  test('strips a leading "the" prefix before deriving the id', () => {
    const gen = new StreamIDGenerator()
    const streams = [
      stream({ link: 'https://a.example/s', source: 'The Stream' }),
    ]
    gen.process(streams)
    expect(streams[0]._id).toBe('str')
  })

  test('strips a leading http(s)/www prefix before deriving the id', () => {
    const gen = new StreamIDGenerator()
    const streams = [
      stream({
        link: 'https://ignored.example/s',
        source: 'http://www.Example.com',
      }),
    ]
    gen.process(streams)
    expect(streams[0]._id).toBe('exa')
  })

  test('skips a stream with no usable id base and leaves it without an id', () => {
    const gen = new StreamIDGenerator()
    const streams = [stream({ link: '' })]
    gen.process(streams)
    expect(streams[0]._id).toBeUndefined()
  })

  test('keeps a stable id for the same link across repeated process() calls', () => {
    const gen = new StreamIDGenerator()
    const first = [stream({ link: 'https://a.example/s', source: 'Example' })]
    gen.process(first)
    expect(first[0]._id).toBe('exa')

    const second = [
      stream({ link: 'https://a.example/s', source: 'Example' }),
      stream({ link: 'https://b.example/s', source: 'Example' }),
    ]
    gen.process(second)
    expect(second[0]._id).toBe('exa')
    expect(second[1]._id).toBe('exa1')
  })
})
