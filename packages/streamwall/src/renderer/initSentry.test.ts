// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const init = vi.fn()
vi.mock('@sentry/electron/renderer', () => ({ init }))

const { initRendererSentry } = await import('./initSentry')

describe('initRendererSentry', () => {
  beforeEach(() => {
    init.mockClear()
    // @ts-expect-error test-only global exposed by the preload script
    delete window.sentryEnabled
  })

  it('initializes Sentry when the preload-exposed flag is enabled', () => {
    window.sentryEnabled = true

    initRendererSentry()

    expect(init).toHaveBeenCalledTimes(1)
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: expect.any(String) }),
    )
  })

  it('does not initialize Sentry when the flag is disabled', () => {
    window.sentryEnabled = false

    initRendererSentry()

    expect(init).not.toHaveBeenCalled()
  })

  it('does not initialize Sentry when the flag is missing entirely', () => {
    initRendererSentry()

    expect(init).not.toHaveBeenCalled()
  })
})
