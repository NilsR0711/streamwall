import { describe, expect, it } from 'vitest'
import {
  routeUplinkWsMessage,
  UPLINK_ERROR_MESSAGE,
} from './uplinkMessageRouting'

describe('routeUplinkWsMessage', () => {
  it('routes binary frames as Yjs updates', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    )

    expect(routeUplinkWsMessage(buffer)).toEqual({
      kind: 'yjs-update',
      update: bytes,
    })
  })

  it('routes a valid uplink command as a command message', () => {
    expect(
      routeUplinkWsMessage(
        JSON.stringify({ type: 'set-view-blurred', viewId: 0, blurred: true }),
      ),
    ).toEqual({
      kind: 'command',
      message: { type: 'set-view-blurred', viewId: 0, blurred: true },
    })
  })

  it('routes a control-server refusal before command dispatch (issue #300)', () => {
    expect(
      routeUplinkWsMessage(JSON.stringify({ error: 'unauthorized' })),
    ).toEqual({
      kind: 'uplink-error',
      reason: 'unauthorized',
      message: UPLINK_ERROR_MESSAGE.unauthorized,
    })
    expect(
      routeUplinkWsMessage(
        JSON.stringify({ error: 'streamwall already connected' }),
      ),
    ).toEqual({
      kind: 'uplink-error',
      reason: 'already-connected',
      message: UPLINK_ERROR_MESSAGE['already-connected'],
    })
  })

  it('routes malformed JSON as a parse error', () => {
    const result = routeUplinkWsMessage('{not json')

    expect(result.kind).toBe('parse-error')
    if (result.kind === 'parse-error') {
      expect(result.error).toBeInstanceOf(SyntaxError)
    }
  })
})
