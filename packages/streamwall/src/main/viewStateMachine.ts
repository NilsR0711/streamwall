import assert from 'assert'
import {
  BrowserWindow,
  Rectangle,
  WebContents,
  WebContentsView,
} from 'electron'
import { isEqual } from 'lodash-es'
import { ViewContent, ViewPos } from 'streamwall-shared'
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
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  enabled: true,
  delay: 5 * 1000,
  maxDelay: 60 * 1000,
  maxRetries: 5,
  stalledTimeout: 30 * 1000,
}

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
      id: number
      view: WebContentsView
      win: BrowserWindow
      offscreenWin: BrowserWindow
      retry: RetryConfig
    },

    context: {} as {
      id: number
      win: BrowserWindow
      offscreenWin: BrowserWindow
      view: WebContentsView
      pos: ViewPos | null
      content: ViewContent | null
      options: ContentDisplayOptions | null
      info: ContentViewInfo | null
      retry: RetryConfig
      // Per-tile playback volume, from 0 (silent) to 1 (full). Independent of
      // the mute/listening state: it is the level applied once the tile is
      // unmuted.
      volume: number
      // Human-readable reason for the current error, or null when healthy.
      error: string | null
      // Number of automatic reloads already spent on the current failure streak.
      retryCount: number
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
      | { type: 'MUTE' }
      | { type: 'UNMUTE' }
      | { type: 'BACKGROUND' }
      | { type: 'UNBACKGROUND' }
      | { type: 'BLUR' }
      | { type: 'UNBLUR' }
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
  },

  delays: {
    // Exponential backoff, capped, computed from how many attempts have already
    // been spent on the current failure streak.
    retryBackoff: ({ context }) =>
      Math.min(
        context.retry.delay * 2 ** context.retryCount,
        context.retry.maxDelay,
      ),

    stalledTimeout: ({ context }) => context.retry.stalledTimeout,
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
          loadHTML(wc, 'playHLS', { query: { src: content.url } })
        } else {
          // Do NOT await: the preload sends VIEW_INIT before loadURL resolves
          // (did-finish-load), so awaiting here would strand that event and hang
          // the view in waitForInit. Load failures are surfaced via the
          // webContents 'did-fail-load' listener in StreamWindow; swallow the
          // rejection so it isn't an unhandled promise rejection.
          wc.loadURL(content.url).catch(() => {})
        }
      },
    ),
  },
}).createMachine({
  id: 'view',
  initial: 'empty',
  context: ({ input: { id, view, win, offscreenWin, retry } }) => ({
    id,
    view,
    win,
    offscreenWin,
    pos: null,
    content: null,
    options: null,
    info: null,
    retry,
    error: null,
    retryCount: 0,
    volume: 1,
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
          // Reaching running means the view recovered: clear any error streak so
          // the next failure starts its backoff from scratch.
          entry: ['positionView', 'resetRetryState'],
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
              // reassignment) while this cell was already running: reload
              // straight into `loading` as a sibling transition instead of
              // going through the root DISPLAY handler, which would re-enter
              // `displaying` and repeat its entry actions -- most visibly
              // `offscreenView`, which briefly pulls the view out of the wall
              // even though it's already live and positioned there. This
              // still fully reloads the WebContentsView (see `loadPage`);
              // there is no crossfade or seamless handoff. Removing that
              // reload cost would require preloading the next view in
              // parallel before swapping it in.
              {
                target: '#view.displaying.loading',
                actions: assign({
                  pos: ({ event }) => event.pos,
                  content: ({ event }) => event.content,
                }),
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
                playing: {},
                stalled: {
                  // A view that stays stalled past the watchdog is reloaded
                  // (as long as it still has retry budget). A stall that clears
                  // on its own (VIEW_LOADED -> playing) simply cancels this.
                  after: {
                    stalledTimeout: {
                      target: '#view.displaying.loading',
                      guard: 'canRetry',
                      actions: 'incrementRetry',
                    },
                  },
                },
              },
            },
            audio: {
              initial: 'muted',
              on: {
                MUTE: '.muted',
                UNMUTE: '.listening',
                BACKGROUND: '.background',
                UNBACKGROUND: '.muted',
              },
              states: {
                muted: {
                  entry: 'muteAudio',
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
                BLUR: '.blurred',
                UNBLUR: '.normal',
              },
              states: {
                normal: {},
                blurred: {},
              },
            },
          },
        },
        error: {
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
