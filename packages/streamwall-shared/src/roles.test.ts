import { describe, expect, it } from 'vitest'
import {
  invitableRoles,
  inviteLink,
  isInvitableRole,
  roleCan,
  type StreamwallAction,
  validRoles,
} from './roles.ts'

// Independently re-declared expectations for the role × action matrix. These
// arrays intentionally mirror the (unexported) action sets in roles.ts so the
// test pins the *intended* authorization contract rather than re-deriving it
// from the implementation. `satisfies` keeps every listed action a valid
// StreamwallAction, so removing an action from roles.ts breaks this file loudly.

// Gated to admin/local only (the AdminAction union in roles.ts).
const adminOnlyActions = [
  'dev-tools',
  'browse',
  'create-invite',
  'delete-token',
  'view-server-status',
] as const satisfies readonly StreamwallAction[]

// Actions an operator may perform that a monitor may not.
const operatorOnlyActions = [
  'set-listening-view',
  'set-view-background-listening',
  'update-custom-stream',
  'delete-custom-stream',
  'rotate-stream',
  'reload-view',
  'set-view-fullscreen',
  'set-stream-running',
  'mutate-state-doc',
  'set-grid-size',
  'save-layout-preset',
  'load-layout-preset',
  'delete-layout-preset',
  'set-view-volume',
  'add-favorite',
  'remove-favorite',
] as const satisfies readonly StreamwallAction[]

// Available to every authenticated role down to monitor.
const monitorActions = [
  'set-view-blurred',
  'set-stream-censored',
] as const satisfies readonly StreamwallAction[]

const allActions: readonly StreamwallAction[] = [
  ...adminOnlyActions,
  ...operatorOnlyActions,
  ...monitorActions,
]

// The exact set of actions each role is expected to be allowed.
const allowedByRole: Record<
  (typeof validRoles)[number],
  ReadonlySet<StreamwallAction>
> = {
  local: new Set(allActions),
  admin: new Set(allActions),
  operator: new Set<StreamwallAction>([
    ...operatorOnlyActions,
    ...monitorActions,
  ]),
  monitor: new Set<StreamwallAction>(monitorActions),
}

describe('roleCan authorization matrix', () => {
  // Table-driven over the full role × action matrix. `set-grid-size` is a
  // listed operator action here (operators may resize the grid); monitors and
  // unauthenticated clients are denied it — see the default-deny block below
  // for genuinely unlisted message types.
  for (const role of validRoles) {
    for (const action of allActions) {
      const expected = allowedByRole[role].has(action)
      it(`${expected ? 'allows' : 'denies'} ${role} → ${action}`, () => {
        expect(roleCan(role, action)).toBe(expected)
      })
    }
  }

  // Unauthenticated clients (null role) may do nothing at all.
  for (const action of allActions) {
    it(`denies unauthenticated (null) → ${action}`, () => {
      expect(roleCan(null, action)).toBe(false)
    })
  }
})

describe('roleCan default-deny for unlisted actions', () => {
  // A message type absent from every role's action set (a future/unknown
  // command) must fall through to the default deny for non-privileged roles.
  // `local` and `admin` are intentionally all-powerful and excluded.
  const unlisted = 'totally-unknown-action' as StreamwallAction

  it('denies operators an action absent from every set', () => {
    expect(roleCan('operator', unlisted)).toBe(false)
  })
  it('denies monitors an action absent from every set', () => {
    expect(roleCan('monitor', unlisted)).toBe(false)
  })
  it('denies unauthenticated clients an action absent from every set', () => {
    expect(roleCan(null, unlisted)).toBe(false)
  })
})

describe('invitableRoles', () => {
  it('excludes the local role, which is reserved for the app itself', () => {
    expect(invitableRoles).not.toContain('local')
  })

  it('contains every other valid role', () => {
    expect([...invitableRoles].sort()).toEqual(
      validRoles.filter((role) => role !== 'local').sort(),
    )
  })
})

describe('isInvitableRole', () => {
  for (const role of invitableRoles) {
    it(`accepts ${role}`, () => {
      expect(isInvitableRole(role)).toBe(true)
    })
  }

  it('rejects the local role', () => {
    expect(isInvitableRole('local')).toBe(false)
  })

  it('rejects an arbitrary string', () => {
    expect(isInvitableRole('totally-not-a-role')).toBe(false)
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

  it('defaults baseURL to an empty string when omitted', () => {
    expect(inviteLink({ tokenId: 'abc', secret: 's3cr3t' })).toBe(
      '/invite/abc#token=s3cr3t',
    )
  })
})
