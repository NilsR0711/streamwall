import { describe, expect, it } from 'vitest'
import { roleCan } from './roles.ts'

describe('roleCan set-grid-size', () => {
  it('allows operators to resize the grid', () => {
    expect(roleCan('operator', 'set-grid-size')).toBe(true)
  })
  it('allows admins and local to resize the grid', () => {
    expect(roleCan('admin', 'set-grid-size')).toBe(true)
    expect(roleCan('local', 'set-grid-size')).toBe(true)
  })
  it('does not allow monitors to resize the grid', () => {
    expect(roleCan('monitor', 'set-grid-size')).toBe(false)
  })
  it('does not allow unauthenticated clients to resize the grid', () => {
    expect(roleCan(null, 'set-grid-size')).toBe(false)
  })
})
