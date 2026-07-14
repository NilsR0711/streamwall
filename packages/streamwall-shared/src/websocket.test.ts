import { describe, expect, test } from 'vitest'
import { isSocketOpen, SOCKET_OPEN } from './websocket.ts'

describe('isSocketOpen', () => {
  test('returns true once the socket reaches OPEN', () => {
    expect(isSocketOpen({ readyState: SOCKET_OPEN })).toBe(true)
  })

  test('returns false while CONNECTING', () => {
    expect(isSocketOpen({ readyState: 0 })).toBe(false)
  })

  test('returns false while CLOSING', () => {
    expect(isSocketOpen({ readyState: 2 })).toBe(false)
  })

  test('returns false while CLOSED', () => {
    expect(isSocketOpen({ readyState: 3 })).toBe(false)
  })
})
