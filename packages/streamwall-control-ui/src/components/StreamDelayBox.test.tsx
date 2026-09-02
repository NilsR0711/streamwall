import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamDelayStatus, StreamwallRole } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { StreamDelayBox } from './StreamDelayBox.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
  vi.restoreAllMocks()
  // happy-dom doesn't implement window.confirm; tests that stub it assign it
  // directly, so undo that here rather than leaving a stale mock behind for
  // later tests.
  // @ts-expect-error -- resetting a test-only stub, not a real property
  delete window.confirm
})

function delayState(
  overrides: Partial<StreamDelayStatus> = {},
): StreamDelayStatus {
  return {
    isConnected: true,
    delaySeconds: 10,
    restartSeconds: 5,
    isCensored: false,
    isStreamRunning: true,
    startTime: Date.now(),
    state: 'censorship.uncensored',
    ...overrides,
  }
}

function renderBox(
  props: Partial<Parameters<typeof StreamDelayBox>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <StreamDelayBox
        role="admin"
        delayState={delayState()}
        setStreamCensored={() => {}}
        setStreamRunning={() => {}}
        {...props}
      />,
      container!,
    )
  })
  return container
}

const CENSOR_BUTTON_TEXTS = new Set([
  'Censor stream',
  'Uncensor stream',
  'Deactivating...',
])
const RUNNING_BUTTON_TEXTS = new Set(['Start stream', 'End stream'])

function findButton(
  el: HTMLDivElement,
  texts: Set<string>,
): HTMLButtonElement | null {
  return (
    (Array.from(el.querySelectorAll('button')).find((button) =>
      texts.has(button.textContent ?? ''),
    ) as HTMLButtonElement | undefined) ?? null
  )
}

function censorButton(el: HTMLDivElement): HTMLButtonElement | null {
  return findButton(el, CENSOR_BUTTON_TEXTS)
}

function runningButton(el: HTMLDivElement): HTMLButtonElement | null {
  return findButton(el, RUNNING_BUTTON_TEXTS)
}

describe('StreamDelayBox', () => {
  describe('buttonText derivation', () => {
    test('shows "Censor stream" while uncensored', () => {
      const el = renderBox({
        delayState: delayState({ isCensored: false }),
      })
      expect(censorButton(el)?.textContent).toBe('Censor stream')
    })

    test('shows "Uncensor stream" while censored', () => {
      const el = renderBox({
        delayState: delayState({ isCensored: true }),
      })
      expect(censorButton(el)?.textContent).toBe('Uncensor stream')
    })

    // matchesState is checked before isCensored, so the transitional state
    // must win even though isCensored is still true during it.
    test('shows "Deactivating..." during the censored.deactivating transition, taking priority over isCensored', () => {
      const el = renderBox({
        delayState: delayState({
          isCensored: true,
          state: 'censorship.censored.deactivating',
        }),
      })
      expect(censorButton(el)?.textContent).toBe('Deactivating...')
    })

    test('does not render the censor button at all while disconnected', () => {
      const el = renderBox({
        delayState: delayState({ isConnected: false }),
      })
      expect(censorButton(el)).toBeNull()
    })
  })

  // happy-dom does not implement window.confirm, so it is stubbed directly
  // rather than spied on (see useTileResize.test.tsx for the same pattern).
  describe('handleToggleStreamRunning confirm() guard', () => {
    test('starts a stopped stream without confirming', () => {
      const confirmSpy = vi.fn().mockReturnValue(true)
      window.confirm = confirmSpy
      const setStreamRunning = vi.fn()
      const el = renderBox({
        delayState: delayState({ isStreamRunning: false }),
        setStreamRunning,
      })

      act(() => {
        runningButton(el)?.click()
      })

      expect(confirmSpy).not.toHaveBeenCalled()
      expect(setStreamRunning).toHaveBeenCalledWith(true)
    })

    test('ends a running stream only after the operator confirms', () => {
      const confirmSpy = vi.fn().mockReturnValue(true)
      window.confirm = confirmSpy
      const setStreamRunning = vi.fn()
      const el = renderBox({
        delayState: delayState({ isStreamRunning: true }),
        setStreamRunning,
      })

      act(() => {
        runningButton(el)?.click()
      })

      expect(confirmSpy).toHaveBeenCalledWith('End stream?')
      expect(setStreamRunning).toHaveBeenCalledWith(false)
    })

    test('does not end the stream when the operator cancels the confirmation', () => {
      window.confirm = vi.fn().mockReturnValue(false)
      const setStreamRunning = vi.fn()
      const el = renderBox({
        delayState: delayState({ isStreamRunning: true }),
        setStreamRunning,
      })

      act(() => {
        runningButton(el)?.click()
      })

      expect(setStreamRunning).not.toHaveBeenCalled()
    })
  })

  describe('role-gated button visibility', () => {
    const cases: Array<[StreamwallRole, boolean]> = [
      ['admin', true],
      ['operator', true],
      ['monitor', false],
    ]

    test.each(cases)(
      'role "%s" sees the start/stop-stream button: %s',
      (role, shouldSee) => {
        const el = renderBox({ role, delayState: delayState() })
        expect(runningButton(el) !== null).toBe(shouldSee)
      },
    )

    test('never shows the start/stop-stream button while disconnected, regardless of role', () => {
      const el = renderBox({
        role: 'admin',
        delayState: delayState({ isConnected: false }),
      })
      expect(runningButton(el)).toBeNull()
    })

    test('shows the censor button to a role that can only censor (monitor), even without set-stream-running', () => {
      const el = renderBox({
        role: 'monitor',
        delayState: delayState({ isStreamRunning: true }),
      })
      expect(censorButton(el)).not.toBeNull()
      expect(runningButton(el)).toBeNull()
    })

    test('hides the censor button once the stream is stopped, regardless of role', () => {
      const el = renderBox({
        role: 'admin',
        delayState: delayState({ isStreamRunning: false }),
      })
      expect(censorButton(el)).toBeNull()
    })
  })

  describe('connection/running status text', () => {
    test('shows "connecting..." while disconnected', () => {
      const el = renderBox({ delayState: delayState({ isConnected: false }) })
      expect(el.textContent).toContain('connecting...')
    })

    test('shows "stream stopped" while the stream is not running', () => {
      const el = renderBox({
        delayState: delayState({ isStreamRunning: false }),
      })
      expect(el.textContent).toContain('stream stopped')
    })

    test('shows neither status message once connected and running', () => {
      const el = renderBox({
        delayState: delayState({ isConnected: true, isStreamRunning: true }),
      })
      expect(el.textContent).not.toContain('connecting...')
      expect(el.textContent).not.toContain('stream stopped')
    })
  })
})
