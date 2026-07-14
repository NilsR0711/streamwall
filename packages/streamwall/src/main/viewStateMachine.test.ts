import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// viewStateMachine imports electron (directly and via ./loadHTML). Stub the
// module so the machine can be exercised without an Electron runtime; the
// electron-touching actions are overridden with no-ops below.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  WebContents: class {},
}))

const { createActor, fromPromise, matchesState } = await import('xstate')
const { default: viewStateMachine, DEFAULT_RETRY_CONFIG } =
  await import('./viewStateMachine')
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

// Replace every electron-touching action and the loadPage actor so only the
// pure state/context logic under test runs. loadPage resolves immediately,
// moving loading.navigate -> loading.waitForInit.
function makeActor(retry: RetryConfig, loadPageImpl?: () => Promise<void>) {
  const machine = viewStateMachine.provide({
    actions: {
      offscreenView: noop,
      positionView: noop,
      muteAudio: noop,
      unmuteAudio: noop,
      openDevTools: noop,
      sendViewOptions: noop,
      sendViewVolume: noop,
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
    },
  })
}

const CONTENT = { url: 'https://example.com/stream', kind: 'video' as const }
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

  it('does not reload a stalled view when retry is disabled', async () => {
    const actor = makeActor(makeRetry({ enabled: false }))
    actor.start()
    await reachRunning(actor)
    actor.send({ type: 'VIEW_STALLED' })

    vi.advanceTimersByTime(60000)

    expect(
      matchesState(
        'displaying.running.playback.stalled',
        actor.getSnapshot().value,
      ),
    ).toBe(true)
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
        muteAudio: noop,
        unmuteAudio: noop,
        openDevTools: noop,
        sendViewOptions: noop,
        sendViewVolume,
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

describe('viewStateMachine content swap while running', () => {
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

  // Same setup as makeActor, but with spies on offscreenView/positionView so
  // tests can assert whether the view was shuffled offscreen and repositioned.
  function makeActorWithPlacementSpies(retry: RetryConfig) {
    const offscreenView = vi.fn()
    const positionView = vi.fn()
    const machine = viewStateMachine.provide({
      actions: {
        offscreenView,
        positionView,
        muteAudio: noop,
        unmuteAudio: noop,
        openDevTools: noop,
        sendViewOptions: noop,
        sendViewVolume: noop,
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
      },
    })
    return { actor, offscreenView, positionView }
  }

  it('reloads directly into loading without re-shuffling the view offscreen', async () => {
    const { actor, offscreenView } = makeActorWithPlacementSpies(makeRetry())
    actor.start()
    await reachRunning(actor)
    expect(offscreenView).toHaveBeenCalledTimes(1)

    actor.send({
      type: 'DISPLAY',
      pos: OTHER_POS,
      content: OTHER_CONTENT,
    })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.loading', snapshot.value)).toBe(true)
    expect(snapshot.context.content).toEqual(OTHER_CONTENT)
    expect(snapshot.context.pos).toEqual(OTHER_POS)
    // The view is already live in the main window; swapping content must not
    // repeat the "move offscreen while it (re)loads" shuffle that a fresh
    // display does.
    expect(offscreenView).toHaveBeenCalledTimes(1)
  })

  it('returns to running with the new content and repositions the view', async () => {
    const { actor, offscreenView, positionView } =
      makeActorWithPlacementSpies(makeRetry())
    actor.start()
    await reachRunning(actor)
    positionView.mockClear()

    actor.send({
      type: 'DISPLAY',
      pos: OTHER_POS,
      content: OTHER_CONTENT,
    })
    await vi.advanceTimersByTimeAsync(0)
    actor.send({ type: 'VIEW_INIT' })
    actor.send({ type: 'VIEW_LOADED' })

    const snapshot = actor.getSnapshot()
    expect(matchesState('displaying.running', snapshot.value)).toBe(true)
    expect(snapshot.context.content).toEqual(OTHER_CONTENT)
    expect(snapshot.context.pos).toEqual(OTHER_POS)
    expect(offscreenView).toHaveBeenCalledTimes(1)
    expect(positionView).toHaveBeenCalledTimes(1)
  })

  it('still performs a fresh load for the new content (retry budget included)', async () => {
    const { actor } = makeActorWithPlacementSpies(makeRetry({ maxRetries: 1 }))
    actor.start()
    await reachRunning(actor)

    actor.send({
      type: 'DISPLAY',
      pos: OTHER_POS,
      content: OTHER_CONTENT,
    })
    actor.send({ type: 'VIEW_ERROR', error: new Error('boom') })

    // A fresh content swap should get its own retry budget rather than
    // inheriting exhaustion from whatever the previous content did.
    expect(actor.getSnapshot().context.retryCount).toBe(0)
  })
})
