import assert from 'assert'
import {
  BrowserWindow,
  Rectangle,
  WebContents,
  WebContentsView,
} from 'electron'
import { isEqual } from 'lodash-es'
import { ViewContent, ViewId, ViewPos } from 'streamwall-shared'
import {
  ContentDisplayOptions,
  ContentViewInfo,
} from 'streamwall-shared/src/types'
import { Actor, assign, fromPromise, setup } from 'xstate'
import { createSessionHostResolver, ensureValidURL } from '../util'
import { loadHTML } from './loadHTML'
import log from './logger'

// Safety net for the whole loading phase (navigate -> waitForInit -> waitForVideo).
// Longer than the media preload's own acquisition timeouts (~20s) so that slow but
// healthy streams are not cut off; only trips when the renderer never responds at all.
const LOADING_TIMEOUT = 45 * 1000

/**
 * Tunables for automatically recovering views that fail to load or stall. A
 * failed/stalled view is reloaded after an exponentially growing delay until it
 * recovers or the attempt budget is exhausted, at which point it stays in the
 * terminal error state (surfaced on the wall and in the control UI).
 */
export interface RetryConfig {
  /** Whether error/stalled views are reloaded automatically at all. */
  enabled: boolean
  /** Base backoff before the first retry, in milliseconds. */
  delay: number
  /** Upper bound for the backoff, in milliseconds. */
  maxDelay: number
  /** Maximum number of automatic reloads before giving up. */
  maxRetries: number
  /** How long a view may stay stalled before it is reloaded, in milliseconds. */
  stalledTimeout: number
  /**
   * How long a view must keep playing without stalling before its failure
   * streak is forgotten, in milliseconds. Merely reaching the running state
   * does not reset the retry budget: a stream that stalls again right after
   * every reload would otherwise cycle forever without ever exhausting it
   * (issue #645).
   */
  healthyDuration: number
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  enabled: true,
  delay: 5 * 1000,
  maxDelay: 60 * 1000,
  maxRetries: 5,
  stalledTimeout: 30 * 1000,
  healthyDuration: 60 * 1000,
}

/**
 * How long to wait before the next automatic reload: exponential in the number
 * of attempts already spent on the current failure streak, capped at maxDelay.
 * Shared by the error state's backoff and the stalled watchdog's growth.
 */
function retryBackoffMs(retry: RetryConfig, retryCount: number): number {
  return Math.min(retry.delay * 2 ** retryCount, retry.maxDelay)
}

/**
 * Reason recorded when a view stays stalled past the watchdog with no retry
 * budget left, so the wall overlay and control UI show an error instead of a
 * loading spinner forever.
 */
export const STALLED_ERROR_MESSAGE = 'Stream stalled'

/**
 * Turns an arbitrary thrown value into a short, serializable reason that can be
 * shown on the wall overlay and in the control UI.
 */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return String(error)
}

const viewStateMachine = setup({
  types: {
    input: {} as {
      id: ViewId
      view: WebContentsView
      win: BrowserWindow
      offscreenWin: BrowserWindow
      retry: RetryConfig
      // Creates and registers a second, hidden WebContentsView (plus its own
      // offscreen host window) that a content swap can preload in the
      // background while the current one keeps displaying. See `next` below.
      createNextView: () => {
        view: WebContentsView
        offscreenWin: BrowserWindow
      }
      // Tears down a view + its offscreen host window created by
      // `createNextView` (or the initial one from input), detaching it from
      // whichever contentView currently holds it.
      disposeView: (view: WebContentsView, offscreenWin: BrowserWindow) => void
    },

    context: {} as {
      id: ViewId
      win: BrowserWindow
      offscreenWin: BrowserWindow
      view: WebContentsView
      pos: ViewPos | null
      content: ViewContent | null
      options: ContentDisplayOptions | null
      info: ContentViewInfo | null
      retry: RetryConfig
      createNextView: () => {
        view: WebContentsView
        offscreenWin: BrowserWindow
      }
      disposeView: (view: WebContentsView, offscreenWin: BrowserWindow) => void
      // The second WebContentsView being preloaded in the background for a
      // content swap while `running`, or null when there is none in flight.
      // Its `content`/`pos` are whatever `context.content`/`context.pos`
      // already hold (those are assigned as soon as the swap starts), so
      // this only needs to carry the view/window pair itself.
      next: { view: WebContentsView; offscreenWin: BrowserWindow } | null
      // Per-tile playback volume, from 0 (silent) to 1 (full). Independent of
      // the mute/listening state: it is the level applied once the tile is
      // unmuted.
      volume: number
      // Human-readable reason for the current error, or null when healthy.
      error: string | null
      // Number of automatic reloads already spent on the current failure streak.
      retryCount: number
      // The MUTE/UNMUTE/BACKGROUND state most recently requested for this
      // view. Tracked independent of `displaying.running.audio` so a request
      // made while the view is still loading (or recovering from an error) is
      // applied as soon as `running` is (re-)entered instead of being dropped.
      desiredAudio: 'muted' | 'listening' | 'background'
      // Same idea as `desiredAudio`, for BLUR/UNBLUR.
      desiredBlurred: boolean
      // Same idea as `desiredAudio`, for PAUSE/RESUME: whether this view's
      // underlying media playback should be paused. Distinct from BLUR,
      // which only hides the video visually via the overlay -- this stops
      // the view actually decoding/fetching. Used by StreamWindow to pause a
      // parked (hidden) view instead of keeping it fully live while it's
      // hidden behind a fullscreen expansion (issue #374).
      desiredPaused: boolean
    },

    events: {} as
      | { type: 'OPTIONS'; options: ContentDisplayOptions }
      | { type: 'SET_VOLUME'; volume: number }
      | {
          type: 'DISPLAY'
          pos: ViewPos
          content: ViewContent
        }
      | { type: 'VIEW_INIT' }
      | { type: 'VIEW_LOADED' }
      | { type: 'VIEW_STALLED' }
      | { type: 'VIEW_INFO'; info: ContentViewInfo }
      | { type: 'VIEW_ERROR'; error: unknown }
      // The preloading second view's counterparts of VIEW_INIT/VIEW_LOADED/
      // VIEW_ERROR, routed separately so they can never be confused with an
      // event about the currently-displayed view.
      | { type: 'NEXT_VIEW_INIT' }
      | { type: 'NEXT_VIEW_LOADED' }
      | { type: 'NEXT_VIEW_ERROR'; error: unknown }
      | { type: 'MUTE' }
      | { type: 'UNMUTE' }
      | { type: 'BACKGROUND' }
      | { type: 'UNBACKGROUND' }
      | { type: 'BLUR' }
      | { type: 'UNBLUR' }
      | { type: 'PAUSE' }
      | { type: 'RESUME' }
      | { type: 'RELOAD' }
      | { type: 'DEVTOOLS'; inWebContents: WebContents },
  },

  actions: {
    logError: (_, params: { error: unknown }) => {
      log.warn(params.error)
    },

    // Store a serializable reason for the current failure so it can be surfaced
    // on the wall overlay and in the control UI.
    setError: assign({
      error: (_, params: { error: unknown }) => formatError(params.error),
    }),

    // Begin another automatic reload: spend one attempt and clear the stale
    // reason while the view loads again.
    incrementRetry: assign({
      retryCount: ({ context }) => context.retryCount + 1,
      error: null,
    }),

    // Forget any prior failure streak: used when a view starts fresh (new
    // content, manual reload) or recovers into the running state.
    resetRetryState: assign({
      retryCount: 0,
      error: null,
    }),

    muteAudio: ({ context }) => {
      context.view.webContents.audioMuted = true
    },

    unmuteAudio: ({ context }) => {
      context.view.webContents.audioMuted = false
    },

    openDevTools: ({ context }, params: { inWebContents: WebContents }) => {
      const { view } = context
      const { inWebContents } = params
      view.webContents.setDevToolsWebContents(inWebContents)
      view.webContents.openDevTools({ mode: 'detach' })
    },

    sendViewOptions: (
      { context },
      params: { options: ContentDisplayOptions },
    ) => {
      const { view } = context
      view.webContents.send('options', params.options)
    },

    sendViewVolume: ({ context }, params: { volume: number }) => {
      const { view } = context
      view.webContents.send('volume', params.volume)
    },

    sendViewPause: ({ context }) => {
      const { view } = context
      view.webContents.send('pause')
    },

    sendViewResume: ({ context }) => {
      const { view } = context
      view.webContents.send('resume')
    },

    offscreenView: ({ context }) => {
      const { view, win, offscreenWin } = context
      win.contentView.removeChildView(view)
      offscreenWin.contentView.addChildView(view)
      const { width, height } = offscreenWin.getBounds()
      view.setBounds({ x: 0, y: 0, width, height })
    },

    positionView: ({ context }) => {
      const { pos, view, win, offscreenWin } = context

      if (!pos) {
        return
      }

      offscreenWin.contentView.removeChildView(view)

      const existingIdx = win.contentView.children.indexOf(view)
      win.contentView.addChildView(
        view,
        existingIdx !== -1
          ? existingIdx
          : // Insert below the overlay (end of the current list because once added, the overlay's index will increase by 1)
            win.contentView.children.length - 1,
      )

      view.setBounds(pos)
    },

    // Attaches the freshly-created preload view to its own hidden offscreen
    // window while it loads, mirroring `offscreenView` for the current view.
    offscreenNextView: ({ context }) => {
      const { next } = context
      assert(next)
      next.offscreenWin.contentView.addChildView(next.view)
      const { width, height } = next.offscreenWin.getBounds()
      next.view.setBounds({ x: 0, y: 0, width, height })
    },

    // Discards a preload in flight (if any): tears down its view/offscreen
    // window and clears the slot. Safe to call when there is no preload.
    disposeStaleNextView: assign(({ context }) => {
      if (context.next) {
        context.disposeView(context.next.view, context.next.offscreenWin)
      }
      return { next: null }
    }),

    // Moves the preloaded view into the wall at the current view's z-index
    // and bounds, then retires the current view. Must run before
    // `promoteNextView` reassigns `context.view`/`context.next`.
    performSwap: ({ context }) => {
      const {
        win,
        view: oldView,
        offscreenWin: oldOffscreenWin,
        next,
        pos,
      } = context
      assert(next)

      const existingIdx = win.contentView.children.indexOf(oldView)
      next.offscreenWin.contentView.removeChildView(next.view)
      win.contentView.addChildView(
        next.view,
        existingIdx !== -1 ? existingIdx : win.contentView.children.length - 1,
      )
      if (pos) {
        next.view.setBounds(pos)
      }

      win.contentView.removeChildView(oldView)
      context.disposeView(oldView, oldOffscreenWin)
    },

    // Promotes the preloaded view to be the view for this cell now that
    // `performSwap` has placed it in the wall and retired the old one.
    promoteNextView: assign(({ context }) => {
      assert(context.next)
      return {
        view: context.next.view,
        offscreenWin: context.next.offscreenWin,
        next: null,
      }
    }),

    // The newly-promoted view is a fresh WebContentsView: reapply the
    // options/volume/mute state that the retired view already had, since
    // none of `running`'s own entry actions re-fire for an in-place swap.
    resyncSwappedView: ({ context }) => {
      const { view, options, volume, desiredAudio, desiredPaused } = context
      view.webContents.audioMuted = desiredAudio === 'muted'
      if (options) {
        view.webContents.send('options', options)
      }
      view.webContents.send('volume', volume)
      // The pause region's `paused` entry action does not re-fire for an
      // in-place swap, so a parked (paused) cell must re-send the pause to
      // the fresh view or it comes up playing (issue #621).
      if (desiredPaused) {
        view.webContents.send('pause')
      }
    },
  },

  guards: {
    contentUnchanged: ({ context }, params: { content: ViewContent }) => {
      return isEqual(context.content, params.content)
    },

    contentPosUnchanged: (
      { context },
      params: { content: ViewContent; pos: Rectangle },
    ) => {
      return (
        isEqual(context.content, params.content) &&
        isEqual(context.pos, params.pos)
      )
    },

    optionsChanged: (
      { context },
      params: { options: ContentDisplayOptions },
    ) => {
      return !isEqual(context.options, params.options)
    },

    volumeChanged: ({ context }, params: { volume: number }) => {
      return context.volume !== params.volume
    },

    // Whether the view is still allowed to reload itself automatically.
    canRetry: ({ context }) =>
      context.retry.enabled && context.retryCount < context.retry.maxRetries,

    desiredAudioIsListening: ({ context }) =>
      context.desiredAudio === 'listening',
    desiredAudioIsBackground: ({ context }) =>
      context.desiredAudio === 'background',
    desiredVideoIsBlurred: ({ context }) => context.desiredBlurred,
    desiredPlaybackIsPaused: ({ context }) => context.desiredPaused,
  },

  delays: {
    // Exponential backoff, capped, computed from how many attempts have already
    // been spent on the current failure streak.
    retryBackoff: ({ context }) =>
      retryBackoffMs(context.retry, context.retryCount),

    // The first stall of a streak gets the plain watchdog window to self-heal;
    // consecutive stall-reload cycles extend it by the same exponential
    // backoff the error state applies, so repeated stalls slow down instead of
    // reloading at a fixed cadence (issue #645).
    stalledTimeout: ({ context }) =>
      context.retry.stalledTimeout +
      (context.retryCount > 0
        ? retryBackoffMs(context.retry, context.retryCount)
        : 0),

    healthyDuration: ({ context }) => context.retry.healthyDuration,
  },

  actors: {
    loadPage: fromPromise(
      async ({
        input: { content, view },
      }: {
        input: { content: ViewContent | null; view: WebContentsView }
      }) => {
        assert(content !== null)

        const wc = view.webContents
        await ensureValidURL(content.url, createSessionHostResolver(wc.session))
        wc.audioMuted = true

        if (/\.m3u8?$/.test(content.url)) {
          // Do NOT await (same reason as the loadURL branch below). A reload or
          // swap superseding this in-flight navigation rejects with
          // ERR_ABORTED, which is invisible to the 'did-fail-load' listener;
          // log it so it leaves a breadcrumb instead of an unhandled promise
          // rejection (issue #392/#626).
          loadHTML(wc, 'playHLS', { query: { src: content.url } }).catch(
            (err) => {
              log.warn('error loading HLS view URL', content.url, err)
            },
          )
        } else {
          // Do NOT await: the preload sends VIEW_INIT before loadURL resolves
          // (did-finish-load), so awaiting here would strand that event and hang
          // the view in waitForInit. Load failures are surfaced via the
          // webContents 'did-fail-load' listener in StreamWindow; log the
          // rejection reason (invisible to that listener) so a blocked
          // navigation or network error leaves a breadcrumb instead of an
          // unhandled promise rejection (issue #392).
          wc.loadURL(content.url).catch((err) => {
            log.warn('error loading view URL', content.url, err)
          })
        }
      },
    ),
  },
}).createMachine({
  id: 'view',
  initial: 'empty',
  context: ({
    input: { id, view, win, offscreenWin, retry, createNextView, disposeView },
  }) => ({
    id,
    view,
    win,
    offscreenWin,
    createNextView,
    disposeView,
    next: null,
    pos: null,
    content: null,
    options: null,
    info: null,
    retry,
    error: null,
    retryCount: 0,
    volume: 1,
    desiredAudio: 'muted',
    desiredBlurred: false,
    desiredPaused: false,
  }),
  on: {
    DISPLAY: {
      target: '.displaying',
      actions: assign({
        pos: ({ event }) => event.pos,
        content: ({ event }) => event.content,
      }),
    },
  },
  states: {
    empty: {},
    displaying: {
      id: 'displaying',
      initial: 'loading',
      // New content starts with a clean slate: no prior reason, full retry budget.
      entry: ['offscreenView', 'resetRetryState'],
      on: {
        DISPLAY: {
          actions: assign({
            pos: ({ event }) => event.pos,
          }),
          guard: {
            type: 'contentUnchanged',
            params: ({ event: { content } }) => ({ content }),
          },
        },
        OPTIONS: {
          actions: [
            assign({
              options: ({ event }) => event.options,
            }),
            {
              type: 'sendViewOptions',
              params: ({ event: { options } }) => ({ options }),
            },
          ],
          guard: {
            type: 'optionsChanged',
            params: ({ event: { options } }) => ({ options }),
          },
        },
        SET_VOLUME: {
          actions: [
            assign({
              volume: ({ event }) => event.volume,
            }),
            {
              type: 'sendViewVolume',
              params: ({ event: { volume } }) => ({ volume }),
            },
          ],
          guard: {
            type: 'volumeChanged',
            params: ({ event: { volume } }) => ({ volume }),
          },
        },
        // A manual reload is an operator override: reset the automatic retry
        // budget so the view gets a fresh streak.
        RELOAD: {
          target: '.loading',
          actions: 'resetRetryState',
        },
        DEVTOOLS: {
          actions: {
            type: 'openDevTools',
            params: ({ event: { inWebContents } }) => ({ inWebContents }),
          },
        },
        VIEW_ERROR: {
          target: '.error',
          actions: [
            {
              type: 'logError',
              params: ({ event: { error } }) => ({ error }),
            },
            {
              type: 'setError',
              params: ({ event: { error } }) => ({ error }),
            },
          ],
        },
        VIEW_INFO: {
          actions: assign({
            info: ({ event }) => event.info,
          }),
        },
      },
      states: {
        loading: {
          initial: 'navigate',
          // MUTE/UNMUTE/BACKGROUND/UNBACKGROUND/BLUR/UNBLUR only change
          // behavior once `running`'s own `audio`/`video` regions exist (see
          // below). Record the request instead of silently dropping it, so it
          // is applied as soon as `running` is reached.
          on: {
            MUTE: { actions: assign({ desiredAudio: 'muted' }) },
            UNMUTE: { actions: assign({ desiredAudio: 'listening' }) },
            BACKGROUND: { actions: assign({ desiredAudio: 'background' }) },
            UNBACKGROUND: { actions: assign({ desiredAudio: 'muted' }) },
            BLUR: { actions: assign({ desiredBlurred: true }) },
            UNBLUR: { actions: assign({ desiredBlurred: false }) },
            PAUSE: { actions: assign({ desiredPaused: true }) },
            RESUME: { actions: assign({ desiredPaused: false }) },
          },
          // If the whole loading phase stalls (e.g. the renderer never sends
          // VIEW_INIT/VIEW_LOADED), fail the view instead of hanging forever.
          after: {
            [LOADING_TIMEOUT]: {
              target: '#view.displaying.error',
              actions: [
                {
                  type: 'logError',
                  params: { error: 'Timed out waiting for view to load' },
                },
                {
                  type: 'setError',
                  params: { error: 'Timed out waiting for view to load' },
                },
              ],
            },
          },
          states: {
            navigate: {
              invoke: {
                src: 'loadPage',
                input: ({ context: { content, view } }) => ({ content, view }),
                onDone: {
                  target: 'waitForInit',
                },
                onError: {
                  target: '#view.displaying.error',
                  actions: [
                    {
                      type: 'logError',
                      params: ({ event: { error } }) => ({ error }),
                    },
                    {
                      type: 'setError',
                      params: ({ event: { error } }) => ({ error }),
                    },
                  ],
                },
              },
            },
            waitForInit: {
              on: {
                VIEW_INIT: 'waitForVideo',
              },
            },
            waitForVideo: {
              on: {
                VIEW_LOADED: '#view.displaying.running',
              },
            },
          },
        },
        running: {
          type: 'parallel',
          // Reaching running is not yet proof of recovery: a stream that
          // stalls again right after each reload would otherwise reset its
          // streak on every cycle and never exhaust the retry budget or grow
          // its backoff (issue #645). The streak is instead cleared once the
          // view has stayed healthy for retry.healthyDuration -- see
          // `playback.playing` below.
          entry: 'positionView',
          // Leaving `running` for any reason (manual RELOAD, a renderer-
          // reported VIEW_ERROR, or a stalled-view auto-reload) abandons any
          // preload that was in flight for this cell, so its WebContentsView
          // and offscreen window don't leak.
          exit: 'disposeStaleNextView',
          on: {
            DISPLAY: [
              // Noop if nothing changed.
              {
                guard: {
                  type: 'contentPosUnchanged',
                  params: ({ event: { content, pos } }) => ({ content, pos }),
                },
              },
              {
                actions: [
                  assign({
                    pos: ({ event }) => event.pos,
                  }),
                  'positionView',
                ],
                guard: {
                  type: 'contentUnchanged',
                  params: ({ event: { content } }) => ({ content }),
                },
              },
              // Content actually changed (e.g. a playlist advance or manual
              // reassignment) while this cell was already running and there
              // is no preload already in flight (that case is instead handled
              // by `swap.preloading`'s own DISPLAY handler below, so its
              // `reenter` only restarts `preloading` instead of `running`):
              // preload a second WebContentsView for the new content in the
              // background -- via the `swap` region below -- while the
              // currently displayed view keeps playing undisturbed, instead
              // of reloading it in place.
              {
                target: '#view.displaying.running.swap.preloading',
                actions: [
                  'disposeStaleNextView',
                  assign({
                    pos: ({ event }) => event.pos,
                    content: ({ event }) => event.content,
                  }),
                  assign({
                    next: ({ context }) => context.createNextView(),
                  }),
                  'offscreenNextView',
                ],
              },
            ],
          },
          states: {
            playback: {
              initial: 'playing',
              on: {
                VIEW_STALLED: '.stalled',
                VIEW_LOADED: '.playing',
              },
              states: {
                playing: {
                  // Only sustained playback counts as recovery: after
                  // healthyDuration without a stall (a VIEW_STALLED or a
                  // re-entered VIEW_LOADED restarts this clock by re-entering
                  // `playing`), the failure streak is forgotten so a later
                  // failure starts its budget and backoff from scratch
                  // (issue #645).
                  after: {
                    healthyDuration: {
                      actions: 'resetRetryState',
                    },
                  },
                },
                stalled: {
                  // A view that stays stalled past the watchdog is reloaded
                  // (as long as it still has retry budget). A stall that clears
                  // on its own (VIEW_LOADED -> playing) simply cancels this.
                  after: {
                    stalledTimeout: [
                      {
                        target: '#view.displaying.loading',
                        guard: 'canRetry',
                        actions: 'incrementRetry',
                      },
                      // Retry budget exhausted (or retry disabled): surface a
                      // terminal error instead of showing a loading spinner
                      // forever, mirroring how a spent budget behaves in the
                      // `error` state below.
                      {
                        target: '#view.displaying.error',
                        actions: [
                          {
                            type: 'logError',
                            params: { error: STALLED_ERROR_MESSAGE },
                          },
                          {
                            type: 'setError',
                            params: { error: STALLED_ERROR_MESSAGE },
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
            audio: {
              initial: 'muted',
              on: {
                MUTE: {
                  target: '.muted',
                  actions: assign({ desiredAudio: 'muted' }),
                },
                UNMUTE: {
                  target: '.listening',
                  actions: assign({ desiredAudio: 'listening' }),
                },
                BACKGROUND: {
                  target: '.background',
                  actions: assign({ desiredAudio: 'background' }),
                },
                UNBACKGROUND: {
                  target: '.muted',
                  actions: assign({ desiredAudio: 'muted' }),
                },
              },
              states: {
                muted: {
                  entry: 'muteAudio',
                  // Applies a MUTE/UNMUTE/BACKGROUND requested while the view
                  // was still loading (or recovering from an error), instead
                  // of leaving it stuck muted until explicitly toggled again.
                  always: [
                    {
                      target: 'listening',
                      guard: 'desiredAudioIsListening',
                    },
                    {
                      target: 'background',
                      guard: 'desiredAudioIsBackground',
                    },
                  ],
                },
                listening: {
                  entry: 'unmuteAudio',
                },
                background: {
                  on: {
                    // Ignore normal audio swapping.
                    MUTE: {},
                  },
                  entry: 'unmuteAudio',
                },
              },
            },
            video: {
              initial: 'normal',
              on: {
                BLUR: {
                  target: '.blurred',
                  actions: assign({ desiredBlurred: true }),
                },
                UNBLUR: {
                  target: '.normal',
                  actions: assign({ desiredBlurred: false }),
                },
              },
              states: {
                normal: {
                  // Applies a BLUR requested while the view was still loading
                  // (or recovering from an error).
                  always: {
                    target: 'blurred',
                    guard: 'desiredVideoIsBlurred',
                  },
                },
                blurred: {},
              },
            },
            // Whether this view's underlying media playback is paused,
            // independent of `video` (BLUR) above -- see `desiredPaused`.
            // Used by StreamWindow to stop a parked (hidden) view actually
            // decoding/fetching instead of keeping it fully live while it's
            // hidden behind a fullscreen expansion (issue #374).
            pause: {
              initial: 'unpaused',
              on: {
                PAUSE: {
                  target: '.paused',
                  actions: assign({ desiredPaused: true }),
                },
                RESUME: {
                  target: '.unpaused',
                  actions: [assign({ desiredPaused: false }), 'sendViewResume'],
                },
              },
              states: {
                unpaused: {
                  // Applies a PAUSE requested while the view was still
                  // loading (or recovering from an error).
                  always: {
                    target: 'paused',
                    guard: 'desiredPlaybackIsPaused',
                  },
                },
                paused: {
                  entry: 'sendViewPause',
                },
              },
            },
            // Preloads the next WebContentsView for a content swap in the
            // background, independent of playback/audio/video above, so the
            // currently displayed view is never disturbed until the new one
            // is actually ready to take its place (see the `running.on.
            // DISPLAY` handler that enters `preloading`).
            swap: {
              initial: 'idle',
              states: {
                idle: {},
                preloading: {
                  initial: 'navigate',
                  // Safety net mirroring the top-level LOADING_TIMEOUT: if the
                  // preloaded view never finishes initializing, abandon it
                  // and fall back to a normal reload of the current view
                  // instead of preloading forever.
                  after: {
                    [LOADING_TIMEOUT]: {
                      target: '#view.displaying.loading',
                      actions: {
                        type: 'logError',
                        params: {
                          error: 'Timed out waiting for preloaded view to load',
                        },
                      },
                    },
                  },
                  on: {
                    NEXT_VIEW_ERROR: {
                      target: '#view.displaying.loading',
                      actions: {
                        type: 'logError',
                        params: ({ event: { error } }) => ({ error }),
                      },
                    },
                    // Content changed again while a preload was already in
                    // flight for a since-superseded target (rapid successive
                    // changes): abandon it and restart preloading for the
                    // newest content. `reenter: true` is scoped to this
                    // handler's own state (`preloading`, defined right here),
                    // so only it and its navigate/waitForInit/waitForVideo
                    // descendants re-enter -- `running` itself, and the
                    // currently displayed view, are untouched.
                    DISPLAY: [
                      {
                        guard: {
                          type: 'contentPosUnchanged',
                          params: ({ event: { content, pos } }) => ({
                            content,
                            pos,
                          }),
                        },
                      },
                      {
                        actions: assign({ pos: ({ event }) => event.pos }),
                        guard: {
                          type: 'contentUnchanged',
                          params: ({ event: { content } }) => ({ content }),
                        },
                      },
                      {
                        target: '#view.displaying.running.swap.preloading',
                        reenter: true,
                        actions: [
                          'disposeStaleNextView',
                          assign({
                            pos: ({ event }) => event.pos,
                            content: ({ event }) => event.content,
                          }),
                          assign({
                            next: ({ context }) => context.createNextView(),
                          }),
                          'offscreenNextView',
                        ],
                      },
                    ],
                  },
                  states: {
                    navigate: {
                      invoke: {
                        src: 'loadPage',
                        input: ({ context }) => {
                          assert(context.next)
                          return {
                            content: context.content,
                            view: context.next.view,
                          }
                        },
                        onDone: {
                          target: 'waitForInit',
                        },
                        onError: {
                          target: '#view.displaying.loading',
                          actions: {
                            type: 'logError',
                            params: ({ event: { error } }) => ({ error }),
                          },
                        },
                      },
                    },
                    waitForInit: {
                      on: {
                        NEXT_VIEW_INIT: 'waitForVideo',
                      },
                    },
                    waitForVideo: {
                      on: {
                        NEXT_VIEW_LOADED: {
                          target: '#view.displaying.running.swap.idle',
                          actions: [
                            'performSwap',
                            'promoteNextView',
                            'resyncSwappedView',
                            'resetRetryState',
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        error: {
          // MUTE/UNMUTE/BACKGROUND/UNBACKGROUND/BLUR/UNBLUR requested while
          // recovering from an error are recorded the same way as in
          // `loading` (see above) and applied once `running` is reached.
          on: {
            MUTE: { actions: assign({ desiredAudio: 'muted' }) },
            UNMUTE: { actions: assign({ desiredAudio: 'listening' }) },
            BACKGROUND: { actions: assign({ desiredAudio: 'background' }) },
            UNBACKGROUND: { actions: assign({ desiredAudio: 'muted' }) },
            BLUR: { actions: assign({ desiredBlurred: true }) },
            UNBLUR: { actions: assign({ desiredBlurred: false }) },
            PAUSE: { actions: assign({ desiredPaused: true }) },
            RESUME: { actions: assign({ desiredPaused: false }) },
          },
          // Automatically reload after the backoff delay until the retry budget
          // is spent; then this is a terminal state surfaced to the operator.
          after: {
            retryBackoff: {
              target: '#view.displaying.loading',
              guard: 'canRetry',
              actions: 'incrementRetry',
            },
          },
        },
      },
    },
  },
})

export type ViewActor = Actor<typeof viewStateMachine>

export default viewStateMachine
