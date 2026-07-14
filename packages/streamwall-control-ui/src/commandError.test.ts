import { describe, expect, test, vi } from 'vitest'
import { createErrorSurfacingSend, isErrorResponse } from './commandError'

describe('isErrorResponse', () => {
  test('recognizes a response carrying a string error', () => {
    expect(isErrorResponse({ error: 'unauthorized' })).toBe(true)
  })

  test('recognizes an error response alongside other fields', () => {
    expect(
      isErrorResponse({ response: true, id: 3, error: 'invalid message' }),
    ).toBe(true)
  })

  test('rejects a successful response with no error field', () => {
    expect(isErrorResponse({ response: true, id: 3 })).toBe(false)
  })

  test('rejects a response whose error field is not a string', () => {
    expect(isErrorResponse({ error: 42 })).toBe(false)
  })

  test('rejects undefined', () => {
    expect(isErrorResponse(undefined)).toBe(false)
  })

  test('rejects null', () => {
    expect(isErrorResponse(null)).toBe(false)
  })

  test('rejects primitives', () => {
    expect(isErrorResponse('unauthorized')).toBe(false)
    expect(isErrorResponse(42)).toBe(false)
  })
})

describe('createErrorSurfacingSend', () => {
  test('reports the error and does not invoke the caller callback', () => {
    const rawSend = vi.fn((_msg, cb?: (msg: unknown) => void) => {
      cb?.({ response: true, id: 0, error: 'unauthorized' })
    })
    const onError = vi.fn()
    const callerCb = vi.fn()

    const send = createErrorSurfacingSend(rawSend, onError)
    send({ type: 'set-grid-size', cols: 3, rows: 3 }, callerCb)

    expect(onError).toHaveBeenCalledWith('unauthorized')
    expect(callerCb).not.toHaveBeenCalled()
  })

  test('surfaces the error even when the caller passed no callback at all', () => {
    const rawSend = vi.fn((_msg, cb?: (msg: unknown) => void) => {
      cb?.({ response: true, id: 0, error: 'unauthorized' })
    })
    const onError = vi.fn()

    const send = createErrorSurfacingSend(rawSend, onError)
    send({ type: 'set-grid-size', cols: 3, rows: 3 })

    expect(onError).toHaveBeenCalledWith('unauthorized')
  })

  test('forwards a successful response to the caller callback without reporting an error', () => {
    const rawSend = vi.fn((_msg, cb?: (msg: unknown) => void) => {
      cb?.({ response: true, id: 0, name: 'ops', secret: 's', tokenId: 't' })
    })
    const onError = vi.fn()
    const callerCb = vi.fn()

    const send = createErrorSurfacingSend(rawSend, onError)
    send({ type: 'create-invite', name: 'ops', role: 'operator' }, callerCb)

    expect(onError).not.toHaveBeenCalled()
    expect(callerCb).toHaveBeenCalledWith({
      response: true,
      id: 0,
      name: 'ops',
      secret: 's',
      tokenId: 't',
    })
  })

  test('does nothing when the underlying send never calls back', () => {
    const rawSend = vi.fn()
    const onError = vi.fn()
    const callerCb = vi.fn()

    const send = createErrorSurfacingSend(rawSend, onError)
    send({ type: 'set-grid-size', cols: 3, rows: 3 }, callerCb)

    expect(rawSend).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(callerCb).not.toHaveBeenCalled()
  })
})
