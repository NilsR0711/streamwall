import { asCellIdx, asViewId, MAX_VIEW_ERROR_LENGTH } from 'streamwall-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import log from './logger'

// viewStateMachine imports electron (directly and via ./loadHTML). Stub the
// module so the machine can be exercised without an Electron runtime; the
// electron-touching actions are overridden with no-ops below.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  WebContents: class {},
}))

const { createActor, fromPromise, matchesState } = await import('xstate')
const {
  default: viewStateMachine,
  DEFAULT_RETRY_CONFIG,
  STALLED_ERROR_MESSAGE,
} = await import('./viewStateMachine')
type RetryConfig = import('./viewStateMachine').RetryConfig

const noop = () => {}

// A fast retry config so timers advance quickly and the backoff formula is easy
// to reason about in assertions.
function makeRetry(overrides: Partial<RetryConfig> = {}): RetryConfig {
  return {
    enabled: true,
    delay: 1000,
    maxDelay: 8000,
    maxRetries: 5,
    stalledTimeout: 2000,
    healthyDuration: 10000,
    ...overrides,
  }
}

// Every actor needs a next-view factory + disposer even in tests that never
// exercise the preload path, since they're required `input` fields.
const noopCreateNextView = () => ({
  view: {} as never,
  offscreenWin: {} as never,
})
const noopDisposeView = noop

// Replace every electron-touching action and the loadPage actor so only the
// pure state/context logic under test runs. loadPage resolves immediately,
// moving loading.navigate -> loading.waitForInit.
function makeActor(retry: RetryConfig, loadPageImpl?: () => Promise<void>) {
  const machine = viewStateMachine.provide({
    actions: {
      offscreenView: noop,
      positionView: noop,
      offscreenNextView: noop,
      performSwap: noop,
      resyncSwappedView: noop,
      muteAudio: noop,
      unmuteAudio: noop,
      openDevTools: noop,
      sendViewOptions: noop,
      sendViewVolume: noop,
      sendViewPause: noop,
      sendViewResume: noop,
      logError: noop,
    },
    actors: {
      loadPage: fromPromise(loadPageImpl ?? (async () => {})),
    },
  })
  return createActor(machine, {
    input: {
      id: asViewId(1),
      view: {} as never,
      win: {} as never,
      offscreenWin: {} as never,
      retry,
      createNextView: noopCreateNextView,
      disposeView: noopDisposeView,
    },
  })
}

const CONTENT = { url: 'https://example.com/stream', kind: 'video' as const }
// Distinct from CONTENT so DISPLAY-while-running is recognized as a content
// swap (playlist advance / drag-to-place reassignment) rather than a noop.
const OTHER_CONTENT = {
  url: 'https://example.com/other-stream',
  kind: 'video' as const,
}
const POS = { x: 0, y: 0, width: 100, height: 100, spaces: [asCellIdx(0)] }

function display(actor: ReturnType<typeof makeActor>) {
  actor.send({ type: 'DISPLAY', pos: POS, content: CONTENT })
}

// Drive a freshly-displayed view all the way to the running state. The
// loadPage actor resolves as a microtask, so flush pending timers/promises to
// let loading.navigate advance to waitForInit before signalling init/loaded.
async function reachRunning(actor: ReturnType<typeof makeActor>) {
  display(actor)
  await vi.advanceTimersByTimeAsync(0)
  actor.send({ type: 'VIEW_INIT' })
  actor.send({ type: 'VIEW_LOADED' })
}

describe('viewStateMachine error handling and auto-retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('exposes a default retry config', () => {
    expect(DEFAULT_RETRY_CONFIG).toMatchObject({
      enabled: expect.any(Boolean),
      delay: expect.any(Number),
      maxDelay: expect.any(Number),
      maxRetries: expect.any(Number),
      stalledTimeout: expect.any(Number),
      healthyDuration: expect.any(Number),
    })
  })

  it('records a human-readable reason and enters displaying.error on VIEW_ERROR', () => {
    const actor = makeActor(makeRetry({ enabled: false }))
    actor.start()
    display(actor)

    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.error', snapshot.value)).toBe(true)
    expect(snapshot.context.error).toBe('boom')
  })

  it('stringifies non-Error reasons', () => {
    const actor = makeActor(makeRetry({ enabled: false }))
    actor.start()
    display(actor)

    actor.send({ type: 'VIEW_ERROR', error: 'plain string failure' })

    expect(actor.getSnapshot().context.error).toBe('plain string failure')
  })

  // Issue #770: a rejection reason can wrap a real Error thrown while
  // loading page-supplied content, so its .message could in principle carry
  // attacker-influenced text. Truncating here - the same fix issue #734
  // applied to document.title - keeps an oversized reason from ever pushing
  // a broadcast state frame over the uplink's maxPayload.
  it('truncates an oversized error reason to MAX_VIEW_ERROR_LENGTH', () => {
    const actor = makeActor(makeRetry({ enabled: false }))
    actor.start()
    display(actor)

    const oversized = 'x'.repeat(MAX_VIEW_ERROR_LENGTH + 500)
    actor.send({ type: 'VIEW_ERROR', error: new Error(oversized) })

    expect(actor.getSnapshot().context.error).toBe(
      'x'.repeat(MAX_VIEW_ERROR_LENGTH),
    )
  })

  it('does not truncate an error reason at exactly MAX_VIEW_ERROR_LENGTH', () => {
    const actor = makeActor(makeRetry({ enabled: false }))
    actor.start()
    display(actor)

    const atLimit = 'x'.repeat(MAX_VIEW_ERROR_LENGTH)
    actor.send({ type: 'VIEW_ERROR', error: new Error(atLimit) })

    expect(actor.getSnapshot().context.error).toBe(atLimit)
  })

  it('auto-retries from the error state after the backoff delay', () => {
    const actor = makeActor(makeRetry())
    actor.start()
    display(actor)
    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })
    expect(actor.getSnapshot().context.retryCount).toBe(0)

    vi.advanceTimersByTime(1000) // delay * 2^0

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.loading', snapshot.value)).toBe(true)
    expect(snapshot.context.retryCount).toBe(1)
    expect(snapshot.context.error).toBe(null)
  })

  it('does not retry before the backoff delay elapses', () => {
    const actor = makeActor(makeRetry())
    actor.start()
    display(actor)
    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })

    vi.advanceTimersByTime(999)

    expect(matchesState('displaying.error', actor.getSnapshot().value)).toBe(
      true,
    )
  })

  it('grows the backoff exponentially and caps it at maxDelay', () => {
    const actor = makeActor(makeRetry())
    actor.start()
    display(actor)

    // 1st error -> retry after delay * 2^0 = 1000
    actor.send({ type: 'VIEW_ERROR', error: new Error('e0') })
    vi.advanceTimersByTime(1000)
    expect(actor.getSnapshot().context.retryCount).toBe(1)

    // 2nd error -> retry after delay * 2^1 = 2000
    actor.send({ type: 'VIEW_ERROR', error: new Error('e1') })
    vi.advanceTimersByTime(1999)
    expect(matchesState('displaying.error', actor.getSnapshot().value)).toBe(
      true,
    )
    vi.advanceTimersByTime(1)
    expect(actor.getSnapshot().context.retryCount).toBe(2)

    // 3rd error -> retry after delay * 2^2 = 4000
    actor.send({ type: 'VIEW_ERROR', error: new Error('e2') })
    vi.advanceTimersByTime(4000)
    expect(actor.getSnapshot().context.retryCount).toBe(3)

    // 4th error -> delay * 2^3 = 8000 (== maxDelay)
    actor.send({ type: 'VIEW_ERROR', error: new Error('e3') })
    vi.advanceTimersByTime(8000)
    expect(actor.getSnapshot().context.retryCount).toBe(4)

    // 5th error -> delay * 2^4 = 16000 but capped at maxDelay = 8000
    actor.send({ type: 'VIEW_ERROR', error: new Error('e4') })
    vi.advanceTimersByTime(8000)
    expect(actor.getSnapshot().context.retryCount).toBe(5)
  })

  it('stops retrying once maxRetries is reached', () => {
    const actor = makeActor(makeRetry({ maxRetries: 2 }))
    actor.start()
    display(actor)

    actor.send({ type: 'VIEW_ERROR', error: new Error('e0') })
    vi.advanceTimersByTime(1000)
    actor.send({ type: 'VIEW_ERROR', error: new Error('e1') })
    vi.advanceTimersByTime(2000)
    expect(actor.getSnapshot().context.retryCount).toBe(2)

    // Third failure: budget exhausted, stays terminal.
    actor.send({ type: 'VIEW_ERROR', error: new Error('e2') })
    vi.advanceTimersByTime(60000)

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.error', snapshot.value)).toBe(true)
    expect(snapshot.context.retryCount).toBe(2)
  })

  it('does not auto-retry when retry is disabled', () => {
    const actor = makeActor(makeRetry({ enabled: false }))
    actor.start()
    display(actor)
    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })

    vi.advanceTimersByTime(60000)

    expect(matchesState('displaying.error', actor.getSnapshot().value)).toBe(
      true,
    )
    expect(actor.getSnapshot().context.retryCount).toBe(0)
  })

  it('keeps the retry streak on reaching running until playback stays healthy (issue #645)', async () => {
    const actor = makeActor(makeRetry({ healthyDuration: 5000 }))
    actor.start()
    display(actor)
    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })
    await vi.advanceTimersByTimeAsync(1000)
    expect(actor.getSnapshot().context.retryCount).toBe(1)

    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    // Reaching running is not yet proof of recovery: the streak survives so a
    // stream that fails again right away keeps consuming its budget.
    let snapshot = actor.getSnapshot()
    expect(matchesState('displaying.running', snapshot.value)).toBe(true)
    expect(snapshot.context.retryCount).toBe(1)
    expect(snapshot.context.error).toBe(null)

    await vi.advanceTimersByTimeAsync(4999)
    expect(actor.getSnapshot().context.retryCount).toBe(1)

    // Only after healthyDuration of uninterrupted playback is the streak
    // forgotten.
    await vi.advanceTimersByTimeAsync(1)
    snapshot = actor.getSnapshot()
    expect(snapshot.context.retryCount).toBe(0)
    expect(snapshot.context.error).toBe(null)
  })

  it('reloads a stalled view after the stalled watchdog fires', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'VIEW_STALLED' })
    expect(
      matchesState(
        'displaying.running.playback.stalled',
        actor.getSnapshot().value,
      ),
    ).toBe(true)

    vi.advanceTimersByTime(2000) // stalledTimeout

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.loading', snapshot.value)).toBe(true)
    expect(snapshot.context.retryCount).toBe(1)
  })

  it('surfaces an error instead of reloading a stalled view when retry is disabled', async () => {
    const actor = makeActor(makeRetry({ enabled: false }))
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'VIEW_STALLED' })

    vi.advanceTimersByTime(2000) // stalledTimeout

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.error', snapshot.value)).toBe(true)
    expect(snapshot.context.error).toBe(STALLED_ERROR_MESSAGE)
  })

  it('surfaces a terminal error when a stalled view has no retry budget', async () => {
    // maxRetries: 0 means the budget is already spent when the stall happens
    // (a freshly displayed view starts with a clean streak, so a nonzero
    // budget always allows at least one stall-reload).
    const actor = makeActor(makeRetry({ maxRetries: 0 }))
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'VIEW_STALLED' })
    expect(
      matchesState(
        'displaying.running.playback.stalled',
        actor.getSnapshot().value,
      ),
    ).toBe(true)

    vi.advanceTimersByTime(2000) // stalledTimeout

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.error', snapshot.value)).toBe(true)
    expect(snapshot.context.error).toBe(STALLED_ERROR_MESSAGE)

    // Terminal: with no budget left, no further auto-reload happens.
    vi.advanceTimersByTime(60000)
    expect(matchesState('displaying.error', actor.getSnapshot().value)).toBe(
      true,
    )
  })

  // Drives a view that just began an automatic reload (displaying.loading)
  // back into running, mirroring reachRunning for mid-test reload cycles.
  async function finishReload(actor: ReturnType<typeof makeActor>) {
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })
  }

  it('counts consecutive stall-reload cycles against the retry budget (issue #645)', async () => {
    const actor = makeActor(makeRetry({ maxRetries: 2 }))
    actor.start()
    await reachRunning(actor)

    // 1st stall-reload: fires at the base stalledTimeout.
    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )
    expect(actor.getSnapshot().context.retryCount).toBe(1)

    // Stalling again shortly after the reload continues the streak instead of
    // starting a fresh one.
    await finishReload(actor)
    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000 + 2000) // stalledTimeout + backoff (1000 * 2^1)
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )
    expect(actor.getSnapshot().context.retryCount).toBe(2)

    // Budget exhausted: the next stall becomes a terminal error instead of
    // churning through reloads forever.
    await finishReload(actor)
    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000 + 4000) // stalledTimeout + backoff (1000 * 2^2)

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.error', snapshot.value)).toBe(true)
    expect(snapshot.context.error).toBe(STALLED_ERROR_MESSAGE)
  })

  it('spaces consecutive stall-reloads with growing backoff (issue #645)', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)

    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(actor.getSnapshot().context.retryCount).toBe(1)

    // The second cycle's watchdog waits stalledTimeout + the same exponential
    // backoff the error state would apply (1000 * 2^1 = 2000).
    await finishReload(actor)
    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(
      matchesState(
        'displaying.running.playback.stalled',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )
    expect(actor.getSnapshot().context.retryCount).toBe(2)
  })

  it('resets the stall streak after sustained healthy playback (issue #645)', async () => {
    const actor = makeActor(makeRetry({ healthyDuration: 5000 }))
    actor.start()
    await reachRunning(actor)

    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(actor.getSnapshot().context.retryCount).toBe(1)

    // The reloaded view plays healthily past healthyDuration: the streak is
    // forgotten.
    await finishReload(actor)
    await vi.advanceTimersByTimeAsync(5000)
    expect(actor.getSnapshot().context.retryCount).toBe(0)

    // A later stall starts a fresh streak with the base watchdog delay again.
    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )
    expect(actor.getSnapshot().context.retryCount).toBe(1)
  })

  it('restarts the healthy-playback clock when a stall clears on its own (issue #645)', async () => {
    const actor = makeActor(makeRetry({ healthyDuration: 5000 }))
    actor.start()
    await reachRunning(actor)

    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(actor.getSnapshot().context.retryCount).toBe(1)
    await finishReload(actor)

    // A transient stall that self-heals before the watchdog fires spends no
    // budget, but playback time before it does not count as sustained health.
    await vi.advanceTimersByTimeAsync(3000)
    actor.send({ type: 'VIEW_STALLED' })
    actor.send({ type: 'VIEW_LOADED' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(actor.getSnapshot().context.retryCount).toBe(1)

    // Only healthyDuration of uninterrupted playback resets the streak.
    await vi.advanceTimersByTimeAsync(2000)
    expect(actor.getSnapshot().context.retryCount).toBe(0)
  })

  it('resets the retry budget on a manual RELOAD', () => {
    const actor = makeActor(makeRetry())
    actor.start()
    display(actor)
    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })
    vi.advanceTimersByTime(1000)
    expect(actor.getSnapshot().context.retryCount).toBe(1)

    actor.send({ type: 'RELOAD' })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.loading', snapshot.value)).toBe(true)
    expect(snapshot.context.retryCount).toBe(0)
    expect(snapshot.context.error).toBe(null)
  })

  it('surfaces a reason when the loading phase times out', () => {
    const actor = makeActor(
      makeRetry({ enabled: false }),
      () => new Promise<void>(() => {}), // loadPage never resolves
    )
    actor.start()
    display(actor)

    // LOADING_TIMEOUT is 45s.
    vi.advanceTimersByTime(45 * 1000)

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.error', snapshot.value)).toBe(true)
    expect(snapshot.context.error).toMatch(/timed out/i)
  })
})

describe('viewStateMachine volume control', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Same setup as makeActor, but with a spy on sendViewVolume so tests can
  // assert on what was forwarded to the view's webContents.
  function makeActorWithVolumeSpy(retry: RetryConfig) {
    const sendViewVolume = vi.fn()
    const machine = viewStateMachine.provide({
      actions: {
        offscreenView: noop,
        positionView: noop,
        offscreenNextView: noop,
        performSwap: noop,
        resyncSwappedView: noop,
        muteAudio: noop,
        unmuteAudio: noop,
        openDevTools: noop,
        sendViewOptions: noop,
        sendViewVolume,
        sendViewPause: noop,
        sendViewResume: noop,
        logError: noop,
      },
      actors: {
        loadPage: fromPromise(async () => {}),
      },
    })
    const actor = createActor(machine, {
      input: {
        id: asViewId(1),
        view: {} as never,
        win: {} as never,
        offscreenWin: {} as never,
        retry,
        createNextView: noopCreateNextView,
        disposeView: noopDisposeView,
      },
    })
    return { actor, sendViewVolume }
  }

  it('defaults volume to 1', () => {
    const { actor } = makeActorWithVolumeSpy(makeRetry())
    actor.start()

    expect(actor.getSnapshot().context.volume).toBe(1)
  })

  it('updates context.volume and forwards it to the view on SET_VOLUME', () => {
    const { actor, sendViewVolume } = makeActorWithVolumeSpy(makeRetry())
    actor.start()
    display(actor)

    actor.send({ type: 'SET_VOLUME', volume: 0.4 })

    expect(actor.getSnapshot().context.volume).toBe(0.4)
    expect(sendViewVolume).toHaveBeenCalledTimes(1)
    expect(sendViewVolume).toHaveBeenCalledWith(expect.anything(), {
      volume: 0.4,
    })
  })

  it('applies SET_VOLUME while running, independent of the mute state', async () => {
    const { actor, sendViewVolume } = makeActorWithVolumeSpy(makeRetry())
    actor.start()
    await reachRunning(actor)

    actor.send({ type: 'SET_VOLUME', volume: 0.7 })

    expect(actor.getSnapshot().context.volume).toBe(0.7)
    expect(sendViewVolume).toHaveBeenCalledTimes(1)
  })

  it('does not resend to the view when the volume is unchanged', () => {
    const { actor, sendViewVolume } = makeActorWithVolumeSpy(makeRetry())
    actor.start()
    display(actor)

    actor.send({ type: 'SET_VOLUME', volume: 0.5 })
    actor.send({ type: 'SET_VOLUME', volume: 0.5 })

    expect(sendViewVolume).toHaveBeenCalledTimes(1)
  })
})

describe('viewStateMachine content swap while running (seamless preload)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const OTHER_CONTENT = {
    url: 'https://example.com/other-stream',
    kind: 'video' as const,
  }
  const OTHER_POS = {
    x: 10,
    y: 10,
    width: 50,
    height: 50,
    spaces: [asCellIdx(1)],
  }
  const THIRD_CONTENT = {
    url: 'https://example.com/third-stream',
    kind: 'video' as const,
  }
  const THIRD_POS = {
    x: 20,
    y: 20,
    width: 30,
    height: 30,
    spaces: [asCellIdx(2)],
  }

  // Same setup as makeActor, but with spies on the placement/swap actions and
  // a fake createNextView/disposeView pair so tests can assert exactly when a
  // second view is created, attached, swapped in, or discarded.
  function makeActorWithSwapSpies(retry: RetryConfig) {
    const offscreenView = vi.fn()
    const positionView = vi.fn()
    const offscreenNextView = vi.fn()
    const performSwap = vi.fn()
    const resyncSwappedView = vi.fn()
    const disposeView = vi.fn()
    const createNextView = vi.fn(() => ({
      view: {} as never,
      offscreenWin: {} as never,
    }))
    const machine = viewStateMachine.provide({
      actions: {
        offscreenView,
        positionView,
        offscreenNextView,
        performSwap,
        resyncSwappedView,
        muteAudio: noop,
        unmuteAudio: noop,
        openDevTools: noop,
        sendViewOptions: noop,
        sendViewVolume: noop,
        sendViewPause: noop,
        sendViewResume: noop,
        logError: noop,
      },
      actors: {
        loadPage: fromPromise(async () => {}),
      },
    })
    const actor = createActor(machine, {
      input: {
        id: asViewId(1),
        view: {} as never,
        win: {} as never,
        offscreenWin: {} as never,
        retry,
        createNextView,
        disposeView,
      },
    })
    return {
      actor,
      offscreenView,
      positionView,
      offscreenNextView,
      performSwap,
      resyncSwappedView,
      disposeView,
      createNextView,
    }
  }

  it('preloads a second view for changed content instead of reloading the current one', async () => {
    const { actor, offscreenView, offscreenNextView, createNextView } =
      makeActorWithSwapSpies(makeRetry())
    actor.start()
    await reachRunning(actor)
    expect(offscreenView).toHaveBeenCalledTimes(1)

    actor.send({ type: 'DISPLAY', pos: OTHER_POS, content: OTHER_CONTENT })

    const snapshot = actor.getSnapshot()
    // The cell never leaves `running`: the currently displayed view keeps
    // playing, undisturbed, while the new content loads in the background.
    expect(matchesState('displaying.running', snapshot.value)).toBe(true)
    expect(
      matchesState('displaying.running.swap.preloading', snapshot.value),
    ).toBe(true)
    expect(snapshot.context.content).toEqual(OTHER_CONTENT)
    expect(snapshot.context.pos).toEqual(OTHER_POS)
    expect(snapshot.context.next).not.toBeNull()
    expect(createNextView).toHaveBeenCalledTimes(1)
    expect(offscreenNextView).toHaveBeenCalledTimes(1)
    // No offscreen shuffle of the still-displayed current view.
    expect(offscreenView).toHaveBeenCalledTimes(1)
  })

  it('swaps in the preloaded view once it reports ready, without leaving running', async () => {
    const { actor, performSwap, resyncSwappedView, positionView } =
      makeActorWithSwapSpies(makeRetry())
    actor.start()
    await reachRunning(actor)
    positionView.mockClear()

    actor.send({ type: 'DISPLAY', pos: OTHER_POS, content: OTHER_CONTENT })
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'NEXT_VIEW_INIT' })
    actor.send({ type: 'NEXT_VIEW_LOADED' })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.running.swap.idle', snapshot.value)).toBe(
      true,
    )
    expect(snapshot.context.content).toEqual(OTHER_CONTENT)
    expect(snapshot.context.next).toBeNull()
    expect(performSwap).toHaveBeenCalledTimes(1)
    expect(resyncSwappedView).toHaveBeenCalledTimes(1)
    // running's own entry (positionView) never re-fires: the swap is handled
    // entirely by performSwap, not by re-entering running.
    expect(positionView).not.toHaveBeenCalled()
  })

  it('abandons a stale preload and starts a fresh one when content changes again mid-preload', async () => {
    const { actor, disposeView, createNextView } =
      makeActorWithSwapSpies(makeRetry())
    actor.start()
    await reachRunning(actor)

    actor.send({ type: 'DISPLAY', pos: OTHER_POS, content: OTHER_CONTENT })
    expect(disposeView).not.toHaveBeenCalled()

    actor.send({ type: 'DISPLAY', pos: THIRD_POS, content: THIRD_CONTENT })

    expect(disposeView).toHaveBeenCalledTimes(1)
    expect(createNextView).toHaveBeenCalledTimes(2)
    const snapshot = actor.getSnapshot()
    expect(snapshot.context.content).toEqual(THIRD_CONTENT)
    expect(snapshot.context.pos).toEqual(THIRD_POS)
    expect(
      matchesState('displaying.running.swap.preloading', snapshot.value),
    ).toBe(true)
  })

  it('does not restart an in-flight preload for a duplicate DISPLAY of the same pending target', async () => {
    const { actor, createNextView } = makeActorWithSwapSpies(makeRetry())
    actor.start()
    await reachRunning(actor)

    actor.send({ type: 'DISPLAY', pos: OTHER_POS, content: OTHER_CONTENT })
    actor.send({ type: 'DISPLAY', pos: OTHER_POS, content: OTHER_CONTENT })

    expect(createNextView).toHaveBeenCalledTimes(1)
  })

  it('falls back to a full reload of the current view if the preload errors', async () => {
    const { actor, disposeView } = makeActorWithSwapSpies(makeRetry())
    actor.start()
    await reachRunning(actor)

    actor.send({ type: 'DISPLAY', pos: OTHER_POS, content: OTHER_CONTENT })
    actor.send({ type: 'NEXT_VIEW_ERROR', error: new Error('boom') })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.loading', snapshot.value)).toBe(true)
    expect(snapshot.context.next).toBeNull()
    expect(disposeView).toHaveBeenCalledTimes(1)
    // The content stays the intended target: the fallback reload retries
    // loading it on the existing (still-live) current view.
    expect(snapshot.context.content).toEqual(OTHER_CONTENT)
  })

  it('falls back to a full reload if the preload never finishes within the loading timeout', async () => {
    const { actor, disposeView } = makeActorWithSwapSpies(makeRetry())
    actor.start()
    await reachRunning(actor)

    actor.send({ type: 'DISPLAY', pos: OTHER_POS, content: OTHER_CONTENT })
    await vi.advanceTimersByTimeAsync(45 * 1000) // LOADING_TIMEOUT

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.loading', snapshot.value)).toBe(true)
    expect(snapshot.context.next).toBeNull()
    expect(disposeView).toHaveBeenCalledTimes(1)
  })

  it('discards an in-flight preload when a manual RELOAD interrupts it', async () => {
    const { actor, disposeView } = makeActorWithSwapSpies(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'DISPLAY', pos: OTHER_POS, content: OTHER_CONTENT })

    actor.send({ type: 'RELOAD' })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.loading', snapshot.value)).toBe(true)
    expect(snapshot.context.next).toBeNull()
    expect(disposeView).toHaveBeenCalledTimes(1)
  })

  it('discards an in-flight preload when the current view errors out', async () => {
    const { actor, disposeView } = makeActorWithSwapSpies(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'DISPLAY', pos: OTHER_POS, content: OTHER_CONTENT })

    actor.send({ type: 'VIEW_ERROR', error: new Error('current view crashed') })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.error', snapshot.value)).toBe(true)
    expect(snapshot.context.next).toBeNull()
    expect(disposeView).toHaveBeenCalledTimes(1)
  })

  it('ignores a DISPLAY with unchanged content and position while running', async () => {
    const { actor, offscreenView, positionView, createNextView } =
      makeActorWithSwapSpies(makeRetry())
    actor.start()
    await reachRunning(actor)
    positionView.mockClear()

    actor.send({ type: 'DISPLAY', pos: POS, content: CONTENT })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.running', snapshot.value)).toBe(true)
    expect(snapshot.context.content).toEqual(CONTENT)
    expect(snapshot.context.pos).toEqual(POS)
    // contentPosUnchanged guard: nothing actually changed, so the view must
    // not be re-shuffled offscreen or repositioned, and no preload starts.
    expect(offscreenView).toHaveBeenCalledTimes(1)
    expect(positionView).not.toHaveBeenCalled()
    expect(createNextView).not.toHaveBeenCalled()
  })

  it('repositions the current view for a position-only change while running', async () => {
    const { actor, positionView, createNextView } =
      makeActorWithSwapSpies(makeRetry())
    actor.start()
    await reachRunning(actor)
    positionView.mockClear()

    actor.send({ type: 'DISPLAY', pos: OTHER_POS, content: CONTENT })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.running', snapshot.value)).toBe(true)
    expect(snapshot.context.pos).toEqual(OTHER_POS)
    expect(positionView).toHaveBeenCalledTimes(1)
    expect(createNextView).not.toHaveBeenCalled()
  })

  it('reloads via a manual RELOAD from running without moving the view offscreen again', async () => {
    const { actor, offscreenView } = makeActorWithSwapSpies(makeRetry())
    actor.start()
    await reachRunning(actor)
    expect(offscreenView).toHaveBeenCalledTimes(1)

    actor.send({ type: 'RELOAD' })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.loading', snapshot.value)).toBe(true)
    expect(snapshot.context.content).toEqual(CONTENT)
    expect(snapshot.context.pos).toEqual(POS)
    // RELOAD is handled by the ancestor `displaying` state's own `on`
    // handler, so it is an internal transition from running down into
    // loading: `displaying`'s entry (which includes offscreenView) must not
    // re-fire, unlike a fresh DISPLAY from `empty`.
    expect(offscreenView).toHaveBeenCalledTimes(1)
  })
})

describe('viewStateMachine loadPage navigation', () => {
  // Unlike the other describe blocks, this exercises the real `loadPage`
  // actor instead of overriding it, so it can assert on what the navigate
  // step actually does to the webContents.
  function makeActorWithRealLoadPage(retry: RetryConfig) {
    const executeJavaScript = vi.fn()
    const loadURL = vi.fn().mockResolvedValue(undefined)
    const resolveHost = vi
      .fn()
      .mockResolvedValue({ endpoints: [{ address: '93.184.216.34' }] })

    const view = {
      webContents: {
        session: { resolveHost },
        executeJavaScript,
        loadURL,
        audioMuted: false,
      },
    }

    const machine = viewStateMachine.provide({
      actions: {
        offscreenView: noop,
        positionView: noop,
        offscreenNextView: noop,
        performSwap: noop,
        resyncSwappedView: noop,
        muteAudio: noop,
        unmuteAudio: noop,
        openDevTools: noop,
        sendViewOptions: noop,
        sendViewVolume: noop,
        sendViewPause: noop,
        sendViewResume: noop,
        logError: noop,
      },
    })
    const actor = createActor(machine, {
      input: {
        id: asViewId(1),
        view: view as never,
        win: {} as never,
        offscreenWin: {} as never,
        retry,
        createNextView: noopCreateNextView,
        disposeView: noopDisposeView,
      },
    })
    return { actor, view, executeJavaScript, loadURL }
  }

  it('navigates via loadURL without running any script against the pre-navigation document', async () => {
    const { actor, view, executeJavaScript, loadURL } =
      makeActorWithRealLoadPage(makeRetry())
    actor.start()
    display(actor)

    await vi.waitFor(() => expect(loadURL).toHaveBeenCalled())

    expect(loadURL).toHaveBeenCalledWith(CONTENT.url)
    expect(view.webContents.audioMuted).toBe(true)
    // The visibility spoof used to run here via executeJavaScript against
    // the pre-navigation document, which loadURL immediately discards
    // (see #25). It now lives in mediaPreload.ts instead, so navigate
    // should not touch executeJavaScript at all.
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('logs a warning when the navigation load rejects', async () => {
    // loadURL is intentionally not awaited (see loadPage), so a rejection --
    // e.g. a blocked navigation or network error -- would otherwise vanish
    // with no log breadcrumb (issue #392).
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const { actor, loadURL } = makeActorWithRealLoadPage(makeRetry())
    const loadErr = new Error('net::ERR_CONNECTION_REFUSED')
    loadURL.mockRejectedValue(loadErr)

    actor.start()
    display(actor)

    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        'error loading view URL',
        CONTENT.url,
        loadErr,
      ),
    )

    warnSpy.mockRestore()
  })

  it('logs a warning when the HLS navigation load rejects (issue #626)', async () => {
    // The HLS branch routes through loadHTML (which calls loadURL under the
    // hood) and is likewise not awaited, so a superseding reload/swap that
    // aborts the in-flight navigation would otherwise vanish with no log
    // breadcrumb. Stub the dev-server global so loadHTML takes its loadURL
    // path instead of the packaged loadFile path.
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173')
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const { actor, loadURL } = makeActorWithRealLoadPage(makeRetry())
    const loadErr = new Error('net::ERR_ABORTED')
    loadURL.mockRejectedValue(loadErr)
    const hlsUrl = 'https://example.com/live.m3u8'

    actor.start()
    actor.send({
      type: 'DISPLAY',
      pos: POS,
      content: { url: hlsUrl, kind: 'video' as const },
    })

    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        'error loading HLS view URL',
        hlsUrl,
        loadErr,
      ),
    )

    warnSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})

describe('viewStateMachine deferred MUTE/BLUR/BACKGROUND requests', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('defaults desiredAudio to muted and desiredBlurred to false', () => {
    const actor = makeActor(makeRetry())
    actor.start()

    expect(actor.getSnapshot().context.desiredAudio).toBe('muted')
    expect(actor.getSnapshot().context.desiredBlurred).toBe(false)
  })

  it('applies a deferred UNMUTE requested while still loading once running is reached', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    display(actor)
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )

    actor.send({ type: 'UNMUTE' })
    // Still loading: the audio region doesn't exist yet, so nothing visible
    // changes yet -- the request is only recorded.
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )

    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.audio.listening',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('applies a deferred BACKGROUND requested while still loading once running is reached', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    display(actor)

    actor.send({ type: 'BACKGROUND' })
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.audio.background',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('applies a deferred BLUR requested while still loading once running is reached', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    display(actor)

    actor.send({ type: 'BLUR' })
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.video.blurred',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('applies a deferred UNMUTE requested while recovering from an error', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    display(actor)
    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })
    expect(matchesState('displaying.error', actor.getSnapshot().value)).toBe(
      true,
    )

    actor.send({ type: 'UNMUTE' })

    await vi.advanceTimersByTimeAsync(1000) // delay * 2^0 -> back to loading
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.audio.listening',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a backgrounded view backgrounded across an automatic stalled reload', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'BACKGROUND' })
    expect(
      matchesState(
        'displaying.running.audio.background',
        actor.getSnapshot().value,
      ),
    ).toBe(true)

    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000) // stalledTimeout -> reload
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )

    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.audio.background',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a listening view listening across an automatic stalled reload', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'UNMUTE' })
    expect(
      matchesState(
        'displaying.running.audio.listening',
        actor.getSnapshot().value,
      ),
    ).toBe(true)

    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000) // stalledTimeout -> reload
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )

    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.audio.listening',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a blurred view blurred across an automatic stalled reload', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'BLUR' })
    expect(
      matchesState(
        'displaying.running.video.blurred',
        actor.getSnapshot().value,
      ),
    ).toBe(true)

    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000) // stalledTimeout -> reload
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )

    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.video.blurred',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a listening view listening across an automatic error-retry reload', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'UNMUTE' })

    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })
    expect(matchesState('displaying.error', actor.getSnapshot().value)).toBe(
      true,
    )

    await vi.advanceTimersByTimeAsync(1000) // delay * 2^0 -> back to loading
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.audio.listening',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a blurred view blurred across an automatic error-retry reload', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'BLUR' })

    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })
    await vi.advanceTimersByTimeAsync(1000) // delay * 2^0 -> back to loading
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.video.blurred',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a backgrounded view backgrounded across an automatic error-retry reload', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'BACKGROUND' })

    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })
    await vi.advanceTimersByTimeAsync(1000) // delay * 2^0 -> back to loading
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.audio.background',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a listening view listening across a manual RELOAD', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'UNMUTE' })

    actor.send({ type: 'RELOAD' })
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )

    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.audio.listening',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a blurred view blurred across a manual RELOAD', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'BLUR' })

    actor.send({ type: 'RELOAD' })
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.video.blurred',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a listening view listening across a content swap while running', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'UNMUTE' })

    // A playlist advance / drag-to-place reassignment: same cell, new
    // content. It preloads a second view (see the "seamless preload" describe
    // block above) rather than reloading in place, so the completion events
    // are NEXT_VIEW_INIT/NEXT_VIEW_LOADED and the cell never leaves running.
    actor.send({ type: 'DISPLAY', pos: POS, content: OTHER_CONTENT })
    expect(
      matchesState(
        'displaying.running.swap.preloading',
        actor.getSnapshot().value,
      ),
    ).toBe(true)

    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'NEXT_VIEW_INIT' })
    actor.send({ type: 'NEXT_VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.audio.listening',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a blurred view blurred across a content swap while running', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'BLUR' })

    actor.send({ type: 'DISPLAY', pos: POS, content: OTHER_CONTENT })
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'NEXT_VIEW_INIT' })
    actor.send({ type: 'NEXT_VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.video.blurred',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a backgrounded view backgrounded across a content swap while running', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'BACKGROUND' })

    actor.send({ type: 'DISPLAY', pos: POS, content: OTHER_CONTENT })
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'NEXT_VIEW_INIT' })
    actor.send({ type: 'NEXT_VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.audio.background',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('still ignores MUTE while backgrounded and keeps the desired state as background', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'BACKGROUND' })

    actor.send({ type: 'MUTE' })

    const snapshot = actor.getSnapshot()
    expect(
      matchesState('displaying.running.audio.background', snapshot.value),
    ).toBe(true)
    expect(snapshot.context.desiredAudio).toBe('background')
  })
})

describe('viewStateMachine deferred PAUSE/RESUME requests (issue #374)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('defaults desiredPaused to false', () => {
    const actor = makeActor(makeRetry())
    actor.start()

    expect(actor.getSnapshot().context.desiredPaused).toBe(false)
  })

  it('applies a deferred PAUSE requested while still loading once running is reached', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    display(actor)
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )

    actor.send({ type: 'PAUSE' })
    // Still loading: the pause region doesn't exist yet, so nothing visible
    // changes yet -- the request is only recorded.
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )

    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.pause.paused',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('applies a deferred PAUSE requested while recovering from an error', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    display(actor)
    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })
    expect(matchesState('displaying.error', actor.getSnapshot().value)).toBe(
      true,
    )

    actor.send({ type: 'PAUSE' })

    await vi.advanceTimersByTimeAsync(1000) // delay * 2^0 -> back to loading
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.pause.paused',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('keeps a paused view paused across an automatic stalled reload', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'PAUSE' })
    expect(
      matchesState(
        'displaying.running.pause.paused',
        actor.getSnapshot().value,
      ),
    ).toBe(true)

    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000) // stalledTimeout -> reload
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )

    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.pause.paused',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })

  it('returns to unpaused on RESUME and clears the desired-paused flag', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'PAUSE' })

    actor.send({ type: 'RESUME' })

    const snapshot = actor.getSnapshot()
    expect(
      matchesState('displaying.running.pause.unpaused', snapshot.value),
    ).toBe(true)
    expect(snapshot.context.desiredPaused).toBe(false)
  })

  it('does not pause a freshly-running view that was never asked to pause', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    await reachRunning(actor)

    expect(
      matchesState(
        'displaying.running.pause.unpaused',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
  })
})

describe('viewStateMachine pause/resume IPC (issue #374)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Same setup as makeActor, but with spies on sendViewPause/sendViewResume
  // so tests can assert on what was forwarded to the view's webContents.
  function makeActorWithPauseSpies(retry: RetryConfig) {
    const sendViewPause = vi.fn()
    const sendViewResume = vi.fn()
    const machine = viewStateMachine.provide({
      actions: {
        offscreenView: noop,
        positionView: noop,
        offscreenNextView: noop,
        performSwap: noop,
        resyncSwappedView: noop,
        muteAudio: noop,
        unmuteAudio: noop,
        openDevTools: noop,
        sendViewOptions: noop,
        sendViewVolume: noop,
        sendViewPause,
        sendViewResume,
        logError: noop,
      },
      actors: {
        loadPage: fromPromise(async () => {}),
      },
    })
    const actor = createActor(machine, {
      input: {
        id: asViewId(1),
        view: {} as never,
        win: {} as never,
        offscreenWin: {} as never,
        retry,
        createNextView: noopCreateNextView,
        disposeView: noopDisposeView,
      },
    })
    return { actor, sendViewPause, sendViewResume }
  }

  it('sends a pause message to the view on PAUSE while running', async () => {
    const { actor, sendViewPause } = makeActorWithPauseSpies(makeRetry())
    actor.start()
    await reachRunning(actor)

    actor.send({ type: 'PAUSE' })

    expect(sendViewPause).toHaveBeenCalledTimes(1)
  })

  it('does not send a pause message for a view that was never asked to pause', async () => {
    const { actor, sendViewPause } = makeActorWithPauseSpies(makeRetry())
    actor.start()
    await reachRunning(actor)

    expect(sendViewPause).not.toHaveBeenCalled()
  })

  it('sends a resume message to the view on RESUME after a PAUSE', async () => {
    const { actor, sendViewResume } = makeActorWithPauseSpies(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'PAUSE' })

    actor.send({ type: 'RESUME' })

    expect(sendViewResume).toHaveBeenCalledTimes(1)
  })

  // A parked (paused) view whose stream stalls is reloaded automatically and
  // comes back up paused (the `view-init` reply carries `paused:
  // desiredPaused`). If the operator collapses the expansion while that
  // reload is still in flight, the RESUME lands in `displaying.loading`,
  // where recording `desiredPaused: false` alone leaves the renderer paused
  // forever: `running.pause` starts in `unpaused`, so its `always` guard no
  // longer fires and nothing ever tells the renderer to play again.
  it('sends a resume message when RESUME arrives during a stalled reload (issue #738)', async () => {
    const { actor, sendViewPause, sendViewResume } =
      makeActorWithPauseSpies(makeRetry())
    actor.start()
    await reachRunning(actor)

    // Parked behind a fullscreen expansion.
    actor.send({ type: 'PAUSE' })
    expect(sendViewPause).toHaveBeenCalledTimes(1)

    // While parked the stream stalls and the watchdog reloads it.
    actor.send({ type: 'VIEW_STALLED' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(matchesState('displaying.loading', actor.getSnapshot().value)).toBe(
      true,
    )

    // The operator collapses the expansion mid-reload.
    actor.send({ type: 'DISPLAY', pos: POS, content: CONTENT })
    actor.send({ type: 'RESUME' })

    expect(sendViewResume).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState(
        'displaying.running.pause.unpaused',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
    // The reloaded view must not be paused again on the way back to running.
    expect(sendViewPause).toHaveBeenCalledTimes(1)
  })

  it('sends a resume message when RESUME arrives while recovering from an error (issue #738)', async () => {
    const { actor, sendViewResume } = makeActorWithPauseSpies(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'PAUSE' })

    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })
    expect(matchesState('displaying.error', actor.getSnapshot().value)).toBe(
      true,
    )

    actor.send({ type: 'RESUME' })

    expect(sendViewResume).toHaveBeenCalledTimes(1)
  })

  // The counterpart PAUSE stays deferred on purpose: the renderer's 'pause'
  // handler stops HLS segment fetching, which would starve an acquisition
  // that has not reached view-loaded yet. `running.pause.unpaused`'s `always`
  // guard applies it as soon as the view is running again.
  it('does not send a pause message while the view is still loading', async () => {
    const { actor, sendViewPause } = makeActorWithPauseSpies(makeRetry())
    actor.start()
    display(actor)

    actor.send({ type: 'PAUSE' })

    expect(sendViewPause).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    expect(sendViewPause).toHaveBeenCalledTimes(1)
  })
})

describe('viewStateMachine resyncSwappedView pause re-send (issue #621)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Unlike makeActorWithSwapSpies above, this keeps the REAL resyncSwappedView
  // action and instead fakes the webContents of the preloaded next view, so
  // tests can assert exactly which IPC messages the swapped-in view receives.
  function makeActorWithRealResync(retry: RetryConfig) {
    const nextSend = vi.fn()
    const nextView = { webContents: { send: nextSend, audioMuted: false } }
    const machine = viewStateMachine.provide({
      actions: {
        offscreenView: noop,
        positionView: noop,
        offscreenNextView: noop,
        performSwap: noop,
        muteAudio: noop,
        unmuteAudio: noop,
        openDevTools: noop,
        sendViewOptions: noop,
        sendViewVolume: noop,
        sendViewPause: noop,
        sendViewResume: noop,
        logError: noop,
      },
      actors: {
        loadPage: fromPromise(async () => {}),
      },
    })
    const actor = createActor(machine, {
      input: {
        id: asViewId(1),
        view: {} as never,
        win: {} as never,
        offscreenWin: {} as never,
        retry,
        createNextView: () => ({
          view: nextView as never,
          offscreenWin: {} as never,
        }),
        disposeView: noopDisposeView,
      },
    })
    return { actor, nextSend }
  }

  async function swapToOtherContent(
    actor: ReturnType<typeof makeActorWithRealResync>['actor'],
  ) {
    actor.send({ type: 'DISPLAY', pos: POS, content: OTHER_CONTENT })
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'NEXT_VIEW_INIT' })
    actor.send({ type: 'NEXT_VIEW_LOADED' })
  }

  it('re-sends pause to the swapped-in view when the cell is parked-paused', async () => {
    const { actor, nextSend } = makeActorWithRealResync(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'PAUSE' })

    await swapToOtherContent(actor)

    // The fresh view starts playing on load; without a pause re-send the
    // parked cell silently resumes decoding (and potentially audio).
    expect(nextSend).toHaveBeenCalledWith('pause')
  })

  it('does not send pause to the swapped-in view when the cell is not paused', async () => {
    const { actor, nextSend } = makeActorWithRealResync(makeRetry())
    actor.start()
    await reachRunning(actor)

    await swapToOtherContent(actor)

    // Sanity check that the real resync ran at all for this swap.
    expect(nextSend).toHaveBeenCalledWith('volume', 1)
    expect(nextSend).not.toHaveBeenCalledWith('pause')
  })

  it('does not send pause to the swapped-in view when the cell was resumed before the swap', async () => {
    const { actor, nextSend } = makeActorWithRealResync(makeRetry())
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'PAUSE' })
    actor.send({ type: 'RESUME' })

    await swapToOtherContent(actor)

    expect(nextSend).toHaveBeenCalledWith('volume', 1)
    expect(nextSend).not.toHaveBeenCalledWith('pause')
  })
})

/**
 * `performSwap` moves a finished preload into the wall in place of the view it
 * replaces. A cell parked behind a fullscreen expansion (issue #369) is no
 * longer a child of the wall window at all, so the swap must not put its
 * replacement there either -- it would pop up on top of the expansion at the
 * parked cell's old rectangle, playing, with nothing to remove it until the
 * next layout change (issue #741).
 */
describe('viewStateMachine performSwap while the cell is parked (issue #741)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Minimal stand-in for electron's `contentView` child list. A view has at
   * most one parent there, so re-adding an existing child moves it rather
   * than duplicating it.
   */
  function makeFakeContentView() {
    const children: unknown[] = []
    return {
      children,
      addChildView: vi.fn((child: unknown, index?: number) => {
        const existing = children.indexOf(child)
        if (existing !== -1) {
          children.splice(existing, 1)
        }
        if (index === undefined) {
          children.push(child)
        } else {
          children.splice(index, 0, child)
        }
      }),
      removeChildView: vi.fn((child: unknown) => {
        const idx = children.indexOf(child)
        if (idx !== -1) {
          children.splice(idx, 1)
        }
      }),
    }
  }

  function makeFakeWindow(width: number, height: number) {
    return {
      contentView: makeFakeContentView(),
      getBounds: () => ({ width, height }),
    }
  }

  const NEW_POS = {
    x: 10,
    y: 20,
    width: 50,
    height: 60,
    spaces: [asCellIdx(1)],
  }

  /**
   * Runs the *real* `performSwap`, `positionView` and `offscreenView` (the
   * remaining electron-touching actions are stubbed) against fake
   * windows/views, so the whole park -> swap -> un-park sequence is exercised
   * against the same child-list bookkeeping production does.
   */
  function setup() {
    const win = makeFakeWindow(1920, 1080)
    const overlay = { setBounds: vi.fn() }
    const view = { setBounds: vi.fn() }
    const offscreenWin = makeFakeWindow(100, 100)
    const nextView = { setBounds: vi.fn() }
    const nextOffscreenWin = makeFakeWindow(640, 360)
    const disposeView = vi.fn()

    // The overlay always sits on top of the wall's view layers.
    win.contentView.children.push(overlay)
    nextOffscreenWin.contentView.children.push(nextView)

    const machine = viewStateMachine.provide({
      actions: {
        offscreenNextView: noop,
        resyncSwappedView: noop,
        muteAudio: noop,
        unmuteAudio: noop,
        openDevTools: noop,
        sendViewOptions: noop,
        sendViewVolume: noop,
        sendViewPause: noop,
        sendViewResume: noop,
        logError: noop,
      },
      actors: {
        loadPage: fromPromise(async () => {}),
      },
    })
    const actor = createActor(machine, {
      input: {
        id: asViewId(1),
        view: view as never,
        win: win as never,
        offscreenWin: offscreenWin as never,
        retry: makeRetry(),
        createNextView: () => ({
          view: nextView as never,
          offscreenWin: nextOffscreenWin as never,
        }),
        disposeView,
      },
    })

    /** Exactly what `StreamWindow.hideView` does to park a running view. */
    const park = () => {
      actor.send({ type: 'PARK' })
    }

    /** Drives the running actor through a content swap to its promotion. */
    const swap = async () => {
      actor.send({ type: 'DISPLAY', pos: POS, content: OTHER_CONTENT })
      await vi.advanceTimersByTimeAsync(0)
      actor.send({ type: 'NEXT_VIEW_INIT' })
      actor.send({ type: 'NEXT_VIEW_LOADED' })
    }

    return {
      actor,
      win,
      overlay,
      view,
      offscreenWin,
      nextView,
      nextOffscreenWin,
      disposeView,
      park,
      swap,
    }
  }

  it('adds the promoted view to the wall at the retired view index when the cell is visible', async () => {
    const ctx = setup()
    ctx.actor.start()
    await reachRunning(ctx.actor)

    await ctx.swap()

    expect(ctx.win.contentView.children).toContain(ctx.nextView)
    // Takes the retired view's z-index, i.e. still below the overlay.
    expect(ctx.win.contentView.children.indexOf(ctx.nextView)).toBeLessThan(
      ctx.win.contentView.children.indexOf(ctx.overlay),
    )
    expect(ctx.nextView.setBounds).toHaveBeenCalledWith(POS)
    expect(ctx.win.contentView.children).not.toContain(ctx.view)
    expect(ctx.disposeView).toHaveBeenCalledWith(ctx.view, ctx.offscreenWin)
  })

  it('leaves the promoted view offscreen when the cell is parked', async () => {
    const ctx = setup()
    ctx.actor.start()
    await reachRunning(ctx.actor)
    ctx.park()

    await ctx.swap()

    // Nothing new on the wall: the expansion keeps the whole window.
    expect(ctx.win.contentView.children).toEqual([ctx.overlay])
    // The promoted view stays on the offscreen host it already lives on --
    // the one `promoteNextView` adopts as this actor's offscreen window.
    expect(ctx.nextOffscreenWin.contentView.children).toContain(ctx.nextView)
    // Sized to the offscreen host, never to the parked cell's stale rect.
    expect(ctx.nextView.setBounds).not.toHaveBeenCalledWith(POS)
    expect(ctx.nextView.setBounds).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 640,
      height: 360,
    })
    // The retired view and its host window are reclaimed either way.
    expect(ctx.disposeView).toHaveBeenCalledWith(ctx.view, ctx.offscreenWin)
  })

  it('adopts the promoted view and its offscreen window as the actor context', async () => {
    const ctx = setup()
    ctx.actor.start()
    await reachRunning(ctx.actor)
    ctx.park()

    await ctx.swap()

    const { context } = ctx.actor.getSnapshot()
    expect(context.view).toBe(ctx.nextView)
    expect(context.offscreenWin).toBe(ctx.nextOffscreenWin)
    expect(context.next).toBeNull()
  })

  // The whole reason the swap is finished offscreen rather than abandoned:
  // `context.content` is already the new content, so the DISPLAY that
  // un-parks the cell is a reposition (the `contentUnchanged` guard), and it
  // has to put the *promoted* view on the wall showing that new content.
  it('puts the promoted view on the wall when the cell is un-parked', async () => {
    const ctx = setup()
    ctx.actor.start()
    await reachRunning(ctx.actor)
    ctx.park()
    await ctx.swap()

    // What `StreamWindow.setViews` sends for a reused, previously parked
    // cell on collapse: the content the cell now holds, at its new rect.
    ctx.actor.send({ type: 'DISPLAY', pos: NEW_POS, content: OTHER_CONTENT })

    expect(ctx.win.contentView.children).toEqual([ctx.nextView, ctx.overlay])
    expect(ctx.nextOffscreenWin.contentView.children).not.toContain(
      ctx.nextView,
    )
    expect(ctx.nextView.setBounds).toHaveBeenLastCalledWith(NEW_POS)
    // Still running: un-parking must not restart the load.
    expect(
      matchesState('displaying.running', ctx.actor.getSnapshot().value),
    ).toBe(true)
  })

  it('never puts the retiring view on the wall when a content-changing DISPLAY is immediately followed by UNPARK', async () => {
    // Exactly what `StreamWindow.displayPlannedViews` does on every layout
    // pass: DISPLAY, then unconditionally UNPARK right after, in the same
    // synchronous call -- long before any preload has a chance to finish.
    const ctx = setup()
    ctx.actor.start()
    await reachRunning(ctx.actor)
    ctx.park()

    ctx.actor.send({ type: 'DISPLAY', pos: NEW_POS, content: OTHER_CONTENT })
    ctx.actor.send({ type: 'UNPARK' })

    // Nothing may appear on the wall yet: the old view is stale and about to
    // be retired, and the new one has not loaded. Popping the old view up at
    // this point is exactly the "stale content flashes on the wall" failure
    // the parked-swap handling (issue #741) exists to prevent.
    expect(ctx.win.contentView.children).toEqual([ctx.overlay])
    expect(ctx.actor.getSnapshot().context.parked).toBe(false)

    await vi.advanceTimersByTimeAsync(0)
    ctx.actor.send({ type: 'NEXT_VIEW_INIT' })
    ctx.actor.send({ type: 'NEXT_VIEW_LOADED' })

    // Only once the preload finishes does the promoted view take the cell.
    expect(ctx.win.contentView.children).toEqual([ctx.nextView, ctx.overlay])
    expect(ctx.nextView.setBounds).toHaveBeenLastCalledWith(NEW_POS)
    expect(ctx.win.contentView.children).not.toContain(ctx.view)
  })
})

/**
 * Parking is a state the actor itself tracks (`context.parked`), not an
 * invisible re-parenting done behind its back: a parked view's `pos` and
 * `content` are exactly what they were before the expansion, so the collapse
 * `DISPLAY` matches `contentPosUnchanged` and cannot be what puts the view
 * back on the wall (issue #816).
 */
describe('viewStateMachine PARK/UNPARK (issue #816)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeFakeContentView() {
    const children: unknown[] = []
    return {
      children,
      addChildView: vi.fn((child: unknown, index?: number) => {
        const existing = children.indexOf(child)
        if (existing !== -1) {
          children.splice(existing, 1)
        }
        if (index === undefined) {
          children.push(child)
        } else {
          children.splice(index, 0, child)
        }
      }),
      removeChildView: vi.fn((child: unknown) => {
        const idx = children.indexOf(child)
        if (idx !== -1) {
          children.splice(idx, 1)
        }
      }),
    }
  }

  function makeFakeWindow(width: number, height: number) {
    return {
      contentView: makeFakeContentView(),
      getBounds: () => ({ width, height }),
    }
  }

  /**
   * Runs the *real* `positionView`/`offscreenView` against fake windows, so
   * park/un-park is asserted on the same child-list bookkeeping production
   * uses rather than on a hand-rolled fake actor.
   */
  function setup() {
    const win = makeFakeWindow(1920, 1080)
    const overlay = { setBounds: vi.fn() }
    const view = { setBounds: vi.fn() }
    const offscreenWin = makeFakeWindow(100, 100)

    win.contentView.children.push(overlay)

    const machine = viewStateMachine.provide({
      actions: {
        offscreenNextView: noop,
        performSwap: noop,
        resyncSwappedView: noop,
        muteAudio: noop,
        unmuteAudio: noop,
        openDevTools: noop,
        sendViewOptions: noop,
        sendViewVolume: noop,
        sendViewPause: noop,
        sendViewResume: noop,
        logError: noop,
      },
      actors: {
        loadPage: fromPromise(async () => {}),
      },
    })
    const actor = createActor(machine, {
      input: {
        id: asViewId(1),
        view: view as never,
        win: win as never,
        offscreenWin: offscreenWin as never,
        retry: makeRetry(),
        createNextView: () => ({
          view: {} as never,
          offscreenWin: {} as never,
        }),
        disposeView: noop,
      },
    })

    return { actor, win, overlay, view, offscreenWin }
  }

  it('takes the view off the wall and records the park on PARK', async () => {
    const ctx = setup()
    ctx.actor.start()
    await reachRunning(ctx.actor)
    expect(ctx.win.contentView.children).toContain(ctx.view)

    ctx.actor.send({ type: 'PARK' })

    expect(ctx.win.contentView.children).toEqual([ctx.overlay])
    expect(ctx.offscreenWin.contentView.children).toContain(ctx.view)
    expect(ctx.view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })
    expect(ctx.actor.getSnapshot().context.parked).toBe(true)
  })

  it('re-attaches the view on UNPARK after a DISPLAY that changed nothing', async () => {
    const ctx = setup()
    ctx.actor.start()
    await reachRunning(ctx.actor)
    ctx.actor.send({ type: 'PARK' })

    // What the collapse `setViews` sends: freshly-built but structurally
    // equal pos/content objects, so `contentPosUnchanged` matches and the
    // DISPLAY alone is a noop.
    ctx.actor.send({
      type: 'DISPLAY',
      pos: { ...POS, spaces: [...POS.spaces] },
      content: { ...CONTENT },
    })
    expect(ctx.win.contentView.children).toEqual([ctx.overlay])

    ctx.actor.send({ type: 'UNPARK' })

    // Back on the wall, below the overlay, at its cell rectangle.
    expect(ctx.win.contentView.children).toEqual([ctx.view, ctx.overlay])
    expect(ctx.offscreenWin.contentView.children).not.toContain(ctx.view)
    expect(ctx.view.setBounds).toHaveBeenLastCalledWith(POS)
    expect(ctx.actor.getSnapshot().context.parked).toBe(false)
    // Un-parking must never restart the load.
    expect(
      matchesState('displaying.running', ctx.actor.getSnapshot().value),
    ).toBe(true)
  })

  it('ignores UNPARK for a view that is not parked', async () => {
    const ctx = setup()
    ctx.actor.start()
    await reachRunning(ctx.actor)
    const childrenBefore = [...ctx.win.contentView.children]
    ctx.win.contentView.addChildView.mockClear()

    ctx.actor.send({ type: 'UNPARK' })

    expect(ctx.win.contentView.addChildView).not.toHaveBeenCalled()
    expect(ctx.win.contentView.children).toEqual(childrenBefore)
  })

  it('clears the park when a repositioning DISPLAY already re-attached the view', async () => {
    const ctx = setup()
    ctx.actor.start()
    await reachRunning(ctx.actor)
    ctx.actor.send({ type: 'PARK' })

    const newPos = { ...POS, x: 400, spaces: [asCellIdx(1)] }
    ctx.actor.send({ type: 'DISPLAY', pos: newPos, content: CONTENT })

    expect(ctx.win.contentView.children).toEqual([ctx.view, ctx.overlay])
    expect(ctx.actor.getSnapshot().context.parked).toBe(false)
  })

  it('keeps a parked view offscreen when it reaches running again', async () => {
    const ctx = setup()
    ctx.actor.start()
    await reachRunning(ctx.actor)
    ctx.actor.send({ type: 'PARK' })

    // A parked cell whose view reloads must not pop up on top of the
    // expansion that is still covering it.
    ctx.actor.send({ type: 'RELOAD' })
    await vi.advanceTimersByTimeAsync(0)
    ctx.actor.send({ type: 'VIEW_INIT' })
    ctx.actor.send({ type: 'VIEW_LOADED' })

    expect(
      matchesState('displaying.running', ctx.actor.getSnapshot().value),
    ).toBe(true)
    expect(ctx.win.contentView.children).toEqual([ctx.overlay])
    expect(ctx.actor.getSnapshot().context.parked).toBe(true)

    // The collapse still gets it back.
    ctx.actor.send({ type: 'UNPARK' })
    expect(ctx.win.contentView.children).toEqual([ctx.view, ctx.overlay])
    expect(ctx.actor.getSnapshot().context.parked).toBe(false)
  })

  it('un-parks a view that was parked before it finished loading', async () => {
    const ctx = setup()
    ctx.actor.start()
    // Still in `displaying.loading`: never sent VIEW_INIT/VIEW_LOADED.
    ctx.actor.send({ type: 'DISPLAY', pos: POS, content: CONTENT })
    await vi.advanceTimersByTimeAsync(0)
    ctx.actor.send({ type: 'PARK' })
    expect(ctx.actor.getSnapshot().context.parked).toBe(true)

    // Collapse while the view is still loading: nothing to place yet, but the
    // park must not outlive it, or the view would stay off the wall for good.
    ctx.actor.send({ type: 'DISPLAY', pos: POS, content: CONTENT })
    ctx.actor.send({ type: 'UNPARK' })
    expect(ctx.actor.getSnapshot().context.parked).toBe(false)
    expect(ctx.win.contentView.children).toEqual([ctx.overlay])

    ctx.actor.send({ type: 'VIEW_INIT' })
    ctx.actor.send({ type: 'VIEW_LOADED' })

    expect(ctx.win.contentView.children).toEqual([ctx.view, ctx.overlay])
  })
})
