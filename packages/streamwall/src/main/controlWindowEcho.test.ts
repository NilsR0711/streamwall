import { describe, expect, it } from 'vitest'
import {
  CONTROL_WINDOW_ORIGIN,
  shouldForwardUpdateToControlWindow,
} from './controlWindowEcho'

describe('shouldForwardUpdateToControlWindow', () => {
  it('skips an update whose origin is the control window itself', () => {
    expect(shouldForwardUpdateToControlWindow(CONTROL_WINDOW_ORIGIN)).toBe(
      false,
    )
  })

  it('forwards updates with no origin (e.g. persisted storage load)', () => {
    expect(shouldForwardUpdateToControlWindow(undefined)).toBe(true)
    expect(shouldForwardUpdateToControlWindow(null)).toBe(true)
  })

  it('forwards updates tagged with an unrelated origin (e.g. the uplink)', () => {
    expect(shouldForwardUpdateToControlWindow('uplink')).toBe(true)
  })
})
