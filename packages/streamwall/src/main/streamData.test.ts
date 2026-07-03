import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { sanitizeStreamDataList } from './streamData.ts'

describe('sanitizeStreamDataList', () => {
  test('returns an empty array for non-array payloads', () => {
    assert.deepEqual(sanitizeStreamDataList(null), [])
    assert.deepEqual(sanitizeStreamDataList(undefined), [])
    assert.deepEqual(sanitizeStreamDataList(42), [])
    assert.deepEqual(sanitizeStreamDataList('nope'), [])
    assert.deepEqual(sanitizeStreamDataList(true), [])
    assert.deepEqual(sanitizeStreamDataList({}), [])
    // The classic crash payload: an object wrapping the array.
    assert.deepEqual(
      sanitizeStreamDataList({ streams: [{ link: 'https://a' }] }),
      [],
    )
  })

  test('keeps valid entries with a non-empty string link', () => {
    const input = [
      { link: 'https://a', kind: 'video' },
      { link: 'https://b' },
    ]
    assert.deepEqual(sanitizeStreamDataList(input), input)
  })

  test('drops null and non-object entries', () => {
    const valid = { link: 'https://a' }
    assert.deepEqual(
      sanitizeStreamDataList([null, undefined, 5, 'x', true, valid]),
      [valid],
    )
  })

  test('drops entries without a usable link', () => {
    assert.deepEqual(
      sanitizeStreamDataList([
        { kind: 'video' }, // no link
        { link: '' }, // empty link
        { link: 123 }, // non-string link
        { link: null }, // null link
        { link: 'https://ok' },
      ]),
      [{ link: 'https://ok' }],
    )
  })

  test('preserves entry order and extra fields', () => {
    const input = [
      { link: 'https://a', label: 'A', city: 'X', notes: 'n' },
      { link: 'https://b', source: 'S' },
    ]
    assert.deepEqual(sanitizeStreamDataList(input), input)
  })

  test('does not mutate the input array', () => {
    const input = [{ link: 'https://a' }, null]
    const copy = [...input]
    sanitizeStreamDataList(input)
    assert.deepEqual(input, copy)
  })
})
