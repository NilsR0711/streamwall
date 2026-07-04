import { describe, expect, it } from 'vitest'
import { inviteLink, roleCan } from './roles.ts'

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

describe('inviteLink', () => {
  it('carries the secret in the URL fragment, not the query string', () => {
    const link = inviteLink({
      baseURL: 'https://wall.example.com',
      tokenId: 'abc',
      secret: 's3cr3t',
    })
    expect(link).toBe('https://wall.example.com/invite/abc#token=s3cr3t')
    expect(link).not.toContain('?token=')
  })

  it('keeps the secret out of the part the browser sends to the server', () => {
    const link = inviteLink({ tokenId: 'abc', secret: 's3cr3t' })
    // Everything before the "#" is what lands in the request line and logs.
    const [beforeFragment] = link.split('#')
    expect(beforeFragment).not.toContain('s3cr3t')
    expect(beforeFragment).toBe('/invite/abc')
  })
})
