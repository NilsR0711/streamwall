import { describe, expect, it } from 'vitest'
import { UPLINK_ORIGIN, shouldForwardUpdateToUplink } from './uplinkEcho'

describe('shouldForwardUpdateToUplink', () => {
  it('skips an update whose origin is the uplink itself', () => {
    expect(shouldForwardUpdateToUplink(UPLINK_ORIGIN)).toBe(false)
  })

  it('forwards updates with no origin (e.g. local control window edits)', () => {
    expect(shouldForwardUpdateToUplink(undefined)).toBe(true)
    expect(shouldForwardUpdateToUplink(null)).toBe(true)
  })

  it('forwards updates tagged with an unrelated origin', () => {
    expect(shouldForwardUpdateToUplink('app')).toBe(true)
  })
})
