import { describe, expect, it } from 'vitest'
import { checkUplinkCommandGate } from './uplinkCommandGate'

describe('checkUplinkCommandGate', () => {
  it('allows every command from the local control window', () => {
    expect(checkUplinkCommandGate({ type: 'browse' }, 'local')).toEqual({
      allowed: true,
    })
    expect(checkUplinkCommandGate({ type: 'dev-tools' }, 'local')).toEqual({
      allowed: true,
    })
  })

  it('allows an uplink command on the remote allowlist', () => {
    expect(
      checkUplinkCommandGate(
        { type: 'set-listening-view', viewId: 0 },
        'uplink',
      ),
    ).toEqual({ allowed: true })
  })

  it('rejects a forbidden uplink command with its type for logging', () => {
    expect(checkUplinkCommandGate({ type: 'browse' }, 'uplink')).toEqual({
      allowed: false,
      type: 'browse',
    })
    expect(checkUplinkCommandGate({ type: 'dev-tools' }, 'uplink')).toEqual({
      allowed: false,
      type: 'dev-tools',
    })
    expect(checkUplinkCommandGate({ type: 'create-invite' }, 'uplink')).toEqual(
      {
        allowed: false,
        type: 'create-invite',
      },
    )
  })

  it('rejects an uplink message with no command type (issue #300)', () => {
    expect(checkUplinkCommandGate({}, 'uplink')).toEqual({
      allowed: false,
      type: undefined,
    })
    expect(checkUplinkCommandGate(null, 'uplink')).toEqual({
      allowed: false,
      type: undefined,
    })
    expect(checkUplinkCommandGate({ type: 42 }, 'uplink')).toEqual({
      allowed: false,
      type: 42,
    })
  })
})
