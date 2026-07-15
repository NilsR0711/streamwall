import { describe, expect, test } from 'vitest'
import { collabDataSchema } from './collabData.ts'

describe('collabDataSchema', () => {
  test('accepts an empty views map', () => {
    expect(collabDataSchema.safeParse({ views: {} }).success).toBe(true)
  })

  test('accepts a view with a string streamId', () => {
    expect(
      collabDataSchema.safeParse({ views: { '0': { streamId: 'abc' } } })
        .success,
    ).toBe(true)
  })

  test('accepts a view with no streamId', () => {
    expect(collabDataSchema.safeParse({ views: { '0': {} } }).success).toBe(
      true,
    )
  })

  test('rejects a view with a non-string streamId', () => {
    expect(
      collabDataSchema.safeParse({ views: { '0': { streamId: 42 } } }).success,
    ).toBe(false)
  })

  test('rejects a missing views key', () => {
    expect(collabDataSchema.safeParse({}).success).toBe(false)
  })

  test('rejects a non-object snapshot', () => {
    expect(collabDataSchema.safeParse(undefined).success).toBe(false)
    expect(collabDataSchema.safeParse(null).success).toBe(false)
    expect(collabDataSchema.safeParse('views').success).toBe(false)
  })
})
