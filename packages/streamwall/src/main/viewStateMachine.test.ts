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
      id: 1,
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
const POS = { x: 0, y: 0, width: 100, height: 100, spaces: [0] }

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

  it('resets retry state and clears the error once running is reached', async () => {
    const actor = makeActor(makeRetry())
    actor.start()
    display(actor)
    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })
    await vi.advanceTimersByTimeAsync(1000)
    expect(actor.getSnapshot().context.retryCount).toBe(1)

    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.running', snapshot.value)).toBe(true)
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
    // (reaching `running` resets the streak, so a nonzero budget always allows
    // at least one stall-reload).
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
        id: 1,
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
  const OTHER_POS = { x: 10, y: 10, width: 50, height: 50, spaces: [1] }
  const THIRD_CONTENT = {
    url: 'https://example.com/third-stream',
    kind: 'video' as const,
  }
  const THIRD_POS = { x: 20, y: 20, width: 30, height: 30, spaces: [2] }

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
        id: 1,
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
        id: 1,
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
        id: 1,
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
})
