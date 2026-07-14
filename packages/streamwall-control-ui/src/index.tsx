import '@fontsource/noto-sans'
// Design system fonts (bundled so they work under the strict app CSP).
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/oswald/600.css'
import '@fontsource/saira-stencil-one'
import { orderBy, range, truncate } from 'lodash-es'
import { DateTime } from 'luxon'
import { type JSX } from 'preact'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'preact/hooks'
import { useHotkeys } from 'react-hotkeys-hook'
import {
  FaExchangeAlt,
  FaExclamationTriangle,
  FaRedoAlt,
  FaRegLifeRing,
  FaRegWindowMaximize,
  FaSyncAlt,
  FaVideoSlash,
  FaVolumeUp,
} from 'react-icons/fa'
import {
  MdOutlineStayCurrentLandscape,
  MdOutlineStayCurrentPortrait,
} from 'react-icons/md'
import {
  clampGridDimension,
  Color,
  type ContentKind,
  type ControlCommand,
  type DataSourceHealth,
  GRID_MAX,
  GRID_MIN,
  gridWouldDropAssignments,
  hasGridAssignments,
  idColor,
  inviteLink,
  type LayoutPreset,
  type LocalStreamData,
  parseGridDimensionInput,
  roleCan,
  type StreamData,
  type StreamDelayStatus,
  type StreamwallRole,
  type StreamwallState,
  type StreamWindowConfig,
  type ViewPos,
  type ViewState,
} from 'streamwall-shared'
import { createGlobalStyle, styled } from 'styled-components'
import { matchesState } from 'xstate'
import * as Y from 'yjs'
import { DataSourceHealthBanner } from './DataSourceHealthBanner.tsx'
import {
  computeHoveringIdx,
  isPrimaryButton,
  resolveMoveTarget,
} from './gestures'
import {
  computeResizeAssignments,
  computeSwap,
  isIdxInResizeBox,
  type ResizeHandle,
  type SwapBox,
} from './gridInteractions'
import './index.css'
import { LayoutPresetControls } from './LayoutPresetControls.tsx'
import { LazyChangeInput } from './LazyChangeInput.tsx'
import {
  resolveEagerWriteStreamId,
  resolveTargetViewIdx,
} from './viewPlacement.ts'
import { createSharedUndoManager } from './yUndo.ts'

// `import { Color } from 'streamwall-shared'` binds only the value; alias
// the instance type (as returned by the Color factory) for use in
// styled-component prop types.
type ColorInstance = ReturnType<typeof Color>

export interface ViewInfo {
  state: ViewState
  isListening: boolean
  isBackgroundListening: boolean
  isBlurred: boolean
  volume: number
  spaces: number[]
}

interface Invite {
  tokenId: string
  name: string
  secret: string
}

const hotkeyTriggers = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '0',
  'q',
  'w',
  'e',
  'r',
  't',
  'y',
  'u',
  'i',
  'o',
  'p',
]

/**
 * Label for the `alt+<key>` hotkey that toggles audio on grid cell `idx`, or
 * `undefined` if `idx` falls outside hotkeyTriggers' fixed 20-slot range
 * (grids can have up to GRID_MAX * GRID_MAX = 64 cells, so not every cell has
 * an assigned hotkey).
 */
export function getHotkeyLabel(idx: number): string | undefined {
  const key = hotkeyTriggers[idx]
  return key === undefined ? undefined : `Alt+${key.toUpperCase()}`
}

/**
 * Theme tokens. Light is the base; dark is applied either by the OS setting
 * (prefers-color-scheme) when no explicit choice is made, or by an explicit
 * `data-theme` attribute on <html> (set by the theme switcher).
 *
 *   <html>                       -> follow OS
 *   <html data-theme="system">   -> follow OS
 *   <html data-theme="light">    -> force light
 *   <html data-theme="dark">     -> force dark
 */
const lightTokens = `
  --bg:         #eef1f6;
  --surface:    #ffffff;
  --surface-2:  #f4f6fa;
  --surface-3:  #e9edf3;
  --border:     #dce1ea;
  --border-2:   #c9d1dd;
  --text:       #161b24;
  --text-dim:   #5a6473;
  --text-faint: #9aa3b1;
  --accent:     #d6402a;
  --accent-2:   #0a84ff;
  --accent-soft:#fbe4df;
  --live:       #d6402a;
  --ok:         #17a35a;
  --cell-bg:    #20242c;
  --shadow:     0 6px 22px rgba(40,55,80,.12);
`
const darkTokens = `
  --bg:         #0b0d11;
  --surface:    #13161c;
  --surface-2:  #191d25;
  --surface-3:  #222731;
  --border:     #2a303b;
  --border-2:   #353c49;
  --text:       #e8ecf2;
  --text-dim:   #939cab;
  --text-faint: #5b6470;
  --accent:     #f24d2e;
  --accent-2:   #4cc2ff;
  --accent-soft:#2a1a16;
  --live:       #ff445e;
  --ok:         #3ddc84;
  --cell-bg:    #0e1115;
  --shadow:     0 8px 28px rgba(0,0,0,.45);
`

export const GlobalStyle = createGlobalStyle`
  :root {
    color-scheme: light dark;

    --font-display: 'Saira Stencil One', 'Oswald', system-ui, sans-serif;
    --font-ui: 'IBM Plex Sans', system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', monospace;

    --r-sm: 6px;
    --r-md: 9px;
    --r-lg: 12px;
    --sp: 4px;

    /* base = light */
    ${lightTokens}
  }

  /* Follow the OS when no explicit choice was made */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme]),
    :root[data-theme='system'] {
      ${darkTokens}
    }
  }

  /* Explicit overrides from the theme switcher */
  :root[data-theme='light'] { ${lightTokens} }
  :root[data-theme='dark']  { ${darkTokens} }

  html {
    height: 100%;
  }

  html, body {
    display: flex;
    flex: 1;
    margin: 0;
    /* body is a flex item of html with no explicit min-width, so its
       automatic minimum size falls back to its content's min-content width -
       which can exceed the viewport and inflate body past it even with the
       margin reset above (see #225). */
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
  }

  * { box-sizing: border-box; }

  /* ---- Sidebar (stream list / custom streams / access) ---- */
  .stream-list h2 {
    font-family: var(--font-display);
    font-weight: normal;
    font-size: 15px;
    letter-spacing: 0.04em;
    color: var(--text);
    margin: 24px 0 12px;
    padding-bottom: 6px;
    border-bottom: 2px solid var(--accent);
    display: inline-block;
  }
  .stream-list h3 {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-dim);
    margin: 18px 0 8px;
  }
  .stream-list h3 .ct {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 7px;
    margin-left: 6px;
  }
  .stream-list input,
  .stream-list select {
    font-family: var(--font-ui);
    font-size: 13px;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 7px 10px;
  }
  .stream-list input::placeholder { color: var(--text-faint); }
  .stream-list input:focus,
  .stream-list select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .stream-list .filter-input {
    width: 100%;
    margin-bottom: 4px;
  }
  .stream-list button {
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border: 0;
    border-radius: var(--r-sm);
    padding: 7px 12px;
    cursor: pointer;
  }
  .stream-list button:hover { filter: brightness(1.08); }
  .stream-list a { color: var(--accent-2); text-decoration: none; }
  .stream-list a:hover { text-decoration: underline; }
`

type ThemeChoice = 'system' | 'light' | 'dark'
const THEME_KEY = 'streamwall:theme'

const StyledThemeToggle = styled.div`
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);

  button {
    display: grid;
    place-items: center;
    width: 27px;
    height: 24px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    padding: 0;
  }
  button:hover {
    color: var(--text-dim);
  }
  button.active {
    background: var(--accent);
    color: #fff;
  }
  svg {
    width: 15px;
    height: 15px;
  }
`

/**
 * Theme switcher. Writes the choice to <html data-theme> (read by GlobalStyle)
 * and persists it in localStorage. 'system' clears the override so the OS
 * setting (prefers-color-scheme) takes over.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as ThemeChoice) ?? 'system'
    } catch {
      return 'system'
    }
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // ignore (e.g. storage disabled)
    }
  }, [theme])

  const opts = [
    {
      key: 'system' as const,
      label: 'System',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      ),
    },
    {
      key: 'light' as const,
      label: 'Hell',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ),
    },
    {
      key: 'dark' as const,
      label: 'Dunkel',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      ),
    },
  ]

  return (
    <StyledThemeToggle role="group" aria-label="Color scheme">
      {opts.map(({ key, label, icon }) => (
        <button
          key={key}
          type="button"
          class={theme === key ? 'active' : undefined}
          title={label}
          aria-label={label}
          aria-pressed={theme === key}
          onClick={() => setTheme(key)}
        >
          {icon}
        </button>
      ))}
    </StyledThemeToggle>
  )
}

const normalStreamKinds = new Set(['video', 'audio', 'web'])
function filterStreams(
  streams: StreamData[],
  wallStreamIds: Set<string>,
  filter: string,
) {
  const wallStreams = []
  const liveStreams = []
  const otherStreams = []
  for (const stream of streams) {
    const { _id, kind, status, label, source, state, city } = stream
    if (kind && !normalStreamKinds.has(kind)) {
      continue
    }
    if (
      filter !== '' &&
      !`${label}${source}${state}${city}`
        .toLowerCase()
        .includes(filter.toLowerCase())
    ) {
      continue
    }
    if (wallStreamIds.has(_id)) {
      wallStreams.push(stream)
    } else if ((kind && kind !== 'video') || status === 'Live') {
      liveStreams.push(stream)
    } else {
      otherStreams.push(stream)
    }
  }
  return [wallStreams, liveStreams, otherStreams]
}

export function useYDoc<T>(
  keys: string[],
  // Origin string used by this connection when applying remote updates to
  // `doc` (e.g. `'server'` for the websocket client, `'app'` for the
  // Electron IPC renderer). Passed through to the doc's `Y.UndoManager` so
  // that remotely-applied changes - notably a destructive grid-shrink remap,
  // which runs on the main process's doc and only reaches here as a
  // remote-origin update - are undoable too (issue #79).
  remoteOrigin?: string,
): {
  docValue: T | undefined
  doc: Y.Doc
  setDoc: (doc: Y.Doc) => void
  undoManager: Y.UndoManager | undefined
} {
  const [doc, setDoc] = useState(new Y.Doc())
  const [docValue, setDocValue] = useState<T>()
  useEffect(() => {
    function updateDocValue() {
      const valueCopy = Object.fromEntries(
        keys.map((k) => [k, doc.getMap(k).toJSON()]),
      )
      // TODO: validate using zod
      setDocValue(valueCopy as T)
    }
    updateDocValue()
    doc.on('update', updateDocValue)
    return () => {
      doc.off('update', updateDocValue)
    }
    // `keys` is deliberately omitted: every caller passes a literal array,
    // so including it would re-subscribe the listener on every render
    // without any behavioral benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc])

  const [undoManager, setUndoManager] = useState<Y.UndoManager>()
  useEffect(() => {
    const manager = createSharedUndoManager(doc, keys, remoteOrigin)
    setUndoManager(manager)
    return () => {
      manager.destroy()
    }
    // `keys` is deliberately omitted for the same reason as above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, remoteOrigin])

  return { docValue, doc, setDoc, undoManager }
}

export interface CollabData {
  views: { [viewIdx: string]: { streamId: string | undefined } }
}

export interface StreamwallConnection {
  isConnected: boolean
  role: StreamwallRole | null
  send: (msg: ControlCommand, cb?: (msg: unknown) => void) => void
  sharedState: CollabData | undefined
  stateDoc: Y.Doc
  undoManager?: Y.UndoManager
  config: StreamWindowConfig | undefined
  streams: StreamData[]
  customStreams: StreamData[]
  views: ViewInfo[]
  stateIdxMap: Map<number, ViewInfo>
  delayState: StreamDelayStatus | null | undefined
  authState?: StreamwallState['auth']
  layoutPresets: LayoutPreset[]
  dataSourceHealth: DataSourceHealth[]
}

export function useStreamwallState(state: StreamwallState | undefined) {
  return useMemo(() => {
    if (state === undefined) {
      return {
        role: null,
        config: undefined,
        streams: [],
        customStreams: [],
        views: [],
        stateIdxMap: new Map(),
        delayState: undefined,
        authState: undefined,
        layoutPresets: [],
        dataSourceHealth: [],
      }
    }

    const {
      identity: { role },
      auth,
      config,
      streams: stateStreams,
      views: stateViews,
      streamdelay,
      layoutPresets,
      dataSourceHealth,
    } = state
    const stateIdxMap = new Map()
    const views = []
    for (const viewState of stateViews) {
      const { pos } = viewState.context
      const isListening = matchesState(
        'displaying.running.audio.listening',
        viewState.state,
      )
      const isBackgroundListening = matchesState(
        'displaying.running.audio.background',
        viewState.state,
      )
      const isBlurred = matchesState(
        'displaying.running.video.blurred',
        viewState.state,
      )
      const spaces = pos?.spaces ?? []
      const viewInfo = {
        state: viewState,
        isListening,
        isBackgroundListening,
        isBlurred,
        volume: viewState.context.volume,
        spaces,
      }
      views.push(viewInfo)
      for (const space of spaces) {
        if (!stateIdxMap.has(space)) {
          stateIdxMap.set(space, {})
        }
        Object.assign(stateIdxMap.get(space), viewInfo)
      }
    }

    const streams = orderBy(stateStreams, ['addedDate', '_id'], ['desc', 'asc'])
    const customStreams = stateStreams.filter((s) => s._dataSource === 'custom')

    return {
      role,
      authState: auth,
      delayState: streamdelay,
      views,
      config,
      streams,
      customStreams,
      stateIdxMap,
      layoutPresets,
      dataSourceHealth,
    }
  }, [state])
}

export function ControlUI({
  connection,
}: {
  connection: StreamwallConnection
}) {
  const {
    isConnected,
    send,
    sharedState,
    stateDoc,
    undoManager,
    config,
    streams,
    customStreams,
    views,
    stateIdxMap,
    delayState,
    authState,
    role,
    layoutPresets,
    dataSourceHealth,
  } = connection
  const {
    cols,
    rows,
    width: windowWidth,
    height: windowHeight,
  } = config ?? { cols: null, rows: null, width: null, height: null }

  const [showDebug, setShowDebug] = useState(false)
  const handleChangeShowDebug = useCallback<
    JSX.InputEventHandler<HTMLInputElement>
  >((ev) => {
    setShowDebug(ev.currentTarget.checked)
  }, [])

  const [swapStartIdx, setSwapStartIdx] = useState<number | undefined>()
  const handleSwapView = useCallback(
    (idx: number) => {
      if (!stateIdxMap.has(idx)) {
        return
      }
      // Deselect the input so the contents aren't persisted by GridInput's `editingValue`
      const { activeElement } = document
      if (activeElement && activeElement instanceof HTMLElement) {
        activeElement.blur()
      }
      setSwapStartIdx(idx)
    },
    [stateIdxMap],
  )
  const swapBoxes = useCallback(
    (fromIdx: number, toIdx: number) => {
      stateDoc.transact(() => {
        const viewsMap = stateDoc.getMap<Y.Map<string | undefined>>('views')
        const boxes = new Map<number, SwapBox>(
          [fromIdx, toIdx].map((idx) => [
            idx,
            {
              spaces: stateIdxMap.get(idx)?.spaces ?? [idx],
              streamId: viewsMap.get(String(idx))?.get('streamId'),
            },
          ]),
        )
        const assignments = computeSwap(boxes, fromIdx, toIdx)
        for (const [idx, streamId] of assignments) {
          viewsMap.get(String(idx))?.set('streamId', streamId)
        }
      })
    },
    [stateDoc, stateIdxMap],
  )

  const handleSwap = useCallback(
    (toIdx: number) => {
      if (swapStartIdx === undefined) {
        return
      }
      swapBoxes(swapStartIdx, toIdx)
      setSwapStartIdx(undefined)
    },
    [swapBoxes, swapStartIdx],
  )

  const [hoveringIdx, setHoveringIdx] = useState<number>()
  const updateHoveringIdx = useCallback(
    (ev: PointerEvent) => {
      if (
        cols == null ||
        rows == null ||
        !(ev.currentTarget instanceof HTMLElement)
      ) {
        return
      }
      const { width, height, left, top } =
        ev.currentTarget.getBoundingClientRect()
      setHoveringIdx(
        computeHoveringIdx(
          cols,
          rows,
          width,
          height,
          ev.clientX - left,
          ev.clientY - top,
        ),
      )
    },
    [setHoveringIdx, cols, rows],
  )
  // Clear the hovered cell when the pointer leaves the grid so a gesture
  // released off-grid can't commit against a stale cell. This only fires for
  // mouse pointers — a touch pointer is implicitly captured to its
  // `pointerdown` target and never dispatches boundary events while
  // dragging, so `updateHoveringIdx`'s own bounds check covers that case.
  const clearHoveringIdx = useCallback(() => setHoveringIdx(undefined), [])
  const [moveStart, setMoveStart] = useState<
    { idx: number; x: number; y: number } | undefined
  >()
  const [moveTargetIdx, setMoveTargetIdx] = useState<number | undefined>()

  const handleGridPointerDown = useCallback(
    (ev: PointerEvent) => {
      if (!isPrimaryButton(ev.button) || hoveringIdx == null) {
        return
      }
      if (swapStartIdx !== undefined) {
        handleSwap(hoveringIdx)
        return
      }
      setMoveStart({ idx: hoveringIdx, x: ev.clientX, y: ev.clientY })
    },
    [hoveringIdx, swapStartIdx, handleSwap],
  )

  useLayoutEffect(() => {
    if (moveStart == null) {
      setMoveTargetIdx(undefined)
      return
    }
    setMoveTargetIdx(hoveringIdx)
  }, [moveStart, hoveringIdx])

  useLayoutEffect(() => {
    function endMove(ev: PointerEvent) {
      if (moveStart == null) {
        return
      }
      // pointercancel means the gesture was interrupted (e.g. a system
      // gesture taking over on touch) — abort without committing.
      if (ev.type !== 'pointercancel') {
        const targetIdx = resolveMoveTarget(
          moveStart,
          hoveringIdx,
          ev.clientX,
          ev.clientY,
        )
        if (targetIdx != null) {
          swapBoxes(moveStart.idx, targetIdx)
        }
      }
      setMoveStart(undefined)
    }
    window.addEventListener('pointerup', endMove)
    window.addEventListener('pointercancel', endMove)
    return () => {
      window.removeEventListener('pointerup', endMove)
      window.removeEventListener('pointercancel', endMove)
    }
  }, [moveStart, hoveringIdx, swapBoxes])

  const [resize, setResize] = useState<
    | {
        anchorIdx: number
        streamId: string
        handle: ResizeHandle
        originalSpaces: number[]
      }
    | undefined
  >()

  const handleResizeStart = useCallback(
    (
      anchorIdx: number,
      handle: ResizeHandle,
      originalSpaces: number[],
      ev: PointerEvent,
    ) => {
      if (!isPrimaryButton(ev.button)) {
        return
      }
      ev.preventDefault()
      ev.stopPropagation()
      const streamId = sharedState?.views?.[anchorIdx]?.streamId ?? undefined
      if (streamId == null || streamId === '') {
        return
      }
      setResize({ anchorIdx, streamId, handle, originalSpaces })
    },
    [sharedState],
  )

  useLayoutEffect(() => {
    function endResize(ev: PointerEvent) {
      // A resize only commits while the pointer is over the grid; released
      // off-grid `hoveringIdx` is cleared, so this aborts instead of
      // snapping to a stale cell. A pointercancel likewise aborts.
      if (
        ev.type === 'pointercancel' ||
        resize == null ||
        cols == null ||
        rows == null ||
        hoveringIdx == null
      ) {
        setResize(undefined)
        return
      }
      stateDoc.transact(() => {
        const viewsMap = stateDoc.getMap<Y.Map<string | undefined>>('views')
        const assignments = computeResizeAssignments(
          cols,
          resize.anchorIdx,
          hoveringIdx,
          resize.streamId,
          resize.handle,
          resize.originalSpaces,
        )
        for (const [idx, streamId] of assignments) {
          viewsMap.get(String(idx))?.set('streamId', streamId)
        }
      })
      setResize(undefined)
    }
    window.addEventListener('pointerup', endResize)
    window.addEventListener('pointercancel', endResize)
    return () => {
      window.removeEventListener('pointerup', endResize)
      window.removeEventListener('pointercancel', endResize)
    }
  }, [resize, cols, rows, hoveringIdx, stateDoc])

  const [focusedInputIdx, setFocusedInputIdx] = useState<number | undefined>()
  const handleBlurInput = useCallback(() => setFocusedInputIdx(undefined), [])

  const handleSetView = useCallback(
    (idx: number, streamId: string) => {
      const resolved = resolveEagerWriteStreamId(streams, streamId)
      if (resolved === undefined) {
        return
      }
      stateDoc
        .getMap<Y.Map<string | undefined>>('views')
        .get(String(idx))
        ?.set('streamId', resolved)
    },
    [stateDoc, streams],
  )

  const handleSetListening = useCallback(
    (idx: number, listening: boolean) => {
      send({
        type: 'set-listening-view',
        viewIdx: listening ? idx : null,
      })
    },
    [send],
  )

  const handleSetGridSize = useCallback(
    (nextCols: number, nextRows: number) => {
      const targetCols = clampGridDimension(nextCols)
      const targetRows = clampGridDimension(nextRows)
      // Shrinking the grid permanently drops any placement whose (x, y) no
      // longer fits. Warn before that happens so it is never silent.
      if (cols != null && sharedState) {
        const assignments = new Map<number, string | undefined>()
        for (const [idx, view] of Object.entries(sharedState.views)) {
          assignments.set(Number(idx), view.streamId)
        }
        if (
          gridWouldDropAssignments(cols, targetCols, targetRows, assignments) &&
          !window.confirm(
            'Das neue Raster ist kleiner und entfernt belegte Kacheln dauerhaft. Fortfahren?',
          )
        ) {
          return
        }
      }
      send({
        type: 'set-grid-size',
        cols: targetCols,
        rows: targetRows,
      })
    },
    [send, cols, sharedState],
  )

  const handleSetBackgroundListening = useCallback(
    (viewIdx: number, listening: boolean) => {
      send({
        type: 'set-view-background-listening',
        viewIdx,
        listening,
      })
    },
    [send],
  )

  const handleSetBlurred = useCallback(
    (viewIdx: number, blurred: boolean) => {
      send({
        type: 'set-view-blurred',
        viewIdx,
        blurred,
      })
    },
    [send],
  )

  const handleSetVolume = useCallback(
    (viewIdx: number, volume: number) => {
      send({
        type: 'set-view-volume',
        viewIdx,
        volume,
      })
    },
    [send],
  )

  const handleReloadView = useCallback(
    (viewIdx: number) => {
      send({
        type: 'reload-view',
        viewIdx,
      })
    },
    [send],
  )

  const handleRotateStream = useCallback(
    (streamId: string) => {
      const stream = streams.find((d) => d._id === streamId)
      if (!stream) {
        return
      }
      send({
        type: 'rotate-stream',
        url: stream.link,
        rotation: ((stream.rotation || 0) + 90) % 360,
      })
    },
    [streams, send],
  )

  const handleBrowse = useCallback(
    (streamId: string) => {
      const stream = streams.find((d) => d._id === streamId)
      if (!stream) {
        return
      }
      send({
        type: 'browse',
        url: stream.link,
      })
    },
    [streams, send],
  )

  const handleDevTools = useCallback(
    (viewIdx: number) => {
      send({
        type: 'dev-tools',
        viewIdx,
      })
    },
    [send],
  )

  const handleClickId = useCallback(
    (streamId: string) => {
      if (cols == null || rows == null || sharedState == null) {
        return
      }

      try {
        navigator.clipboard.writeText(streamId)
      } catch (err) {
        console.warn('Unable to copy stream id to clipboard:', err)
      }

      const targetIdx = resolveTargetViewIdx({
        views: sharedState.views,
        cellCount: cols * rows,
        focusedInputIdx,
      })
      if (targetIdx === undefined) {
        return
      }
      handleSetView(targetIdx, streamId)
    },
    [cols, rows, sharedState, focusedInputIdx, handleSetView],
  )

  const handleChangeCustomStream = useCallback(
    (url: string, customStream: LocalStreamData) => {
      send({
        type: 'update-custom-stream',
        url,
        data: customStream,
      })
    },
    [send],
  )

  const handleDeleteCustomStream = useCallback(
    (url: string) => {
      send({
        type: 'delete-custom-stream',
        url,
      })
      return
    },
    [send],
  )

  const setStreamCensored = useCallback(
    (isCensored: boolean) => {
      send({
        type: 'set-stream-censored',
        isCensored,
      })
    },
    [send],
  )

  const setStreamRunning = useCallback(
    (isStreamRunning: boolean) => {
      send({
        type: 'set-stream-running',
        isStreamRunning,
      })
    },
    [send],
  )

  const [newInvite, setNewInvite] = useState<Invite>()

  const handleCreateInvite = useCallback(
    ({ name, role }: { name: string; role: StreamwallRole }) => {
      send(
        {
          type: 'create-invite',
          name,
          role,
        },
        (msg) => {
          setNewInvite(msg as Invite) // TODO: validate w/ Zod
        },
      )
    },
    [send],
  )

  const handleDeleteToken = useCallback(
    (tokenId: string) => {
      send({
        type: 'delete-token',
        tokenId,
      })
    },
    [send],
  )

  const handleSaveLayoutPreset = useCallback(
    (name: string) => {
      send({ type: 'save-layout-preset', name })
    },
    [send],
  )

  const handleLoadLayoutPreset = useCallback(
    (presetId: string) => {
      // Loading a preset unconditionally replaces every cell (see
      // applyLayoutPreset), unlike a grid resize which only drops cells that
      // fall outside the new bounds. So warn whenever the current layout has
      // any live assignment, mirroring handleSetGridSize's confirm above.
      if (sharedState) {
        const assignments = new Map<number, string | undefined>()
        for (const [idx, view] of Object.entries(sharedState.views)) {
          assignments.set(Number(idx), view.streamId)
        }
        if (
          hasGridAssignments(assignments) &&
          !window.confirm(
            'Loading this preset will replace the current layout. Save it as a preset first if you want to keep it. Continue?',
          )
        ) {
          return
        }
      }
      send({ type: 'load-layout-preset', presetId })
    },
    [send, sharedState],
  )

  const handleDeleteLayoutPreset = useCallback(
    (presetId: string) => {
      send({ type: 'delete-layout-preset', presetId })
    },
    [send],
  )

  const preventLinkClick = useCallback((ev: Event) => {
    ev.preventDefault()
  }, [])

  const [streamFilter, setStreamFilter] = useState('')
  const handleStreamFilterChange = useCallback<
    JSX.InputEventHandler<HTMLInputElement>
  >((ev) => {
    setStreamFilter(ev.currentTarget?.value)
  }, [])

  // Set up keyboard shortcuts.
  useHotkeys(
    hotkeyTriggers.map((k) => `alt+${k}`).join(','),
    (ev, { hotkey }) => {
      ev.preventDefault()
      const idx = hotkeyTriggers.indexOf(hotkey[hotkey.length - 1])
      const isListening = stateIdxMap.get(idx)?.isListening ?? false
      handleSetListening(idx, !isListening)
    },
    // This enables the hotkey while a grid input is focused.
    { enableOnFormTags: true },
    [stateIdxMap],
  )
  useHotkeys(
    hotkeyTriggers.map((k) => `alt+shift+${k}`).join(','),
    (ev, { hotkey }) => {
      ev.preventDefault()
      const idx = hotkeyTriggers.indexOf(hotkey[hotkey.length - 1])
      const isBlurred = stateIdxMap.get(idx)?.isBlurred ?? false
      handleSetBlurred(idx, !isBlurred)
    },
    [stateIdxMap],
  )
  useHotkeys(
    `alt+c`,
    () => {
      setStreamCensored(true)
    },
    [setStreamCensored],
  )
  useHotkeys(
    `alt+shift+c`,
    () => {
      setStreamCensored(false)
    },
    [setStreamCensored],
  )
  useHotkeys(
    `alt+s`,
    () => {
      if (focusedInputIdx != null) {
        handleSwapView(focusedInputIdx)
      }
    },
    [handleSwapView, focusedInputIdx],
  )
  // Escape cancels an in-progress drag-move or resize without committing. The
  // window pointerup/pointercancel listeners are no-ops once these are cleared.
  useHotkeys(
    `escape`,
    () => {
      setMoveStart(undefined)
      setResize(undefined)
    },
    // Also fire while a grid input is focused during a gesture.
    { enableOnFormTags: true },
    [setMoveStart, setResize],
  )
  // Undo/redo edits to the shared views doc (drag-move, swap, and destructive
  // grid-shrink remaps alike - see `useYDoc`'s `remoteOrigin` wiring).
  // `enableOnFormTags` defaults to false so this doesn't hijack native
  // undo/redo while a text input (e.g. a grid-size field) is focused.
  useHotkeys(
    'mod+z',
    (ev) => {
      ev.preventDefault()
      undoManager?.undo()
    },
    [undoManager],
  )
  useHotkeys(
    'mod+shift+z',
    (ev) => {
      ev.preventDefault()
      undoManager?.redo()
    },
    [undoManager],
  )

  const wallStreamIds = useMemo(
    () =>
      new Set(
        Object.values(sharedState?.views ?? {})
          .map(({ streamId }) => streamId)
          .filter((x) => x !== undefined),
      ),
    [sharedState],
  )
  const [wallStreams, liveStreams, otherStreams] = useMemo(
    () => filterStreams(streams, wallStreamIds, streamFilter),
    [streams, wallStreamIds, streamFilter],
  )
  function StreamList({ rows }: { rows: StreamData[] }) {
    return rows.map((row) => (
      <StreamLine
        id={row._id}
        row={row}
        disabled={!roleCan(role, 'mutate-state-doc')}
        onClickId={handleClickId}
      />
    ))
  }

  return (
    <AppShell className="app-shell">
      <Stack className="grid-container">
        <StyledHeader>
          <div className="wm">
            STREAM<span>·</span>WALL
          </div>
          <div className="crumbs">
            //&nbsp; <b>Multiview</b> &nbsp;·&nbsp; {cols}×{rows}
          </div>
          {cols != null && rows != null && (
            <GridSizeControls
              cols={cols}
              rows={rows}
              role={role}
              onSetGridSize={handleSetGridSize}
            />
          )}
          <LayoutPresetControls
            presets={layoutPresets}
            role={role}
            onSavePreset={handleSaveLayoutPreset}
            onLoadPreset={handleLoadLayoutPreset}
            onDeletePreset={handleDeleteLayoutPreset}
          />
          <div className="spacer" />
          {liveStreams.length > 0 && (
            <div className="livecount">● {liveStreams.length} On Air</div>
          )}
          {role !== 'local' && (
            <div className="status">
              <span className={`dot ${isConnected ? 'on' : 'off'}`} />
              {isConnected ? 'verbunden' : 'verbinde…'} · {role}
            </div>
          )}
          <ThemeToggle />
        </StyledHeader>
        <DataSourceHealthBanner dataSourceHealth={dataSourceHealth} />
        {delayState && (
          <StreamDelayBox
            role={role}
            delayState={delayState}
            setStreamCensored={setStreamCensored}
            setStreamRunning={setStreamRunning}
          />
        )}
        <StyledDataContainer
          $isConnected={isConnected}
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          {cols != null && rows != null && (
            <StyledGridContainer
              className="grid"
              onPointerMove={updateHoveringIdx}
              onPointerLeave={clearHoveringIdx}
              $windowWidth={windowWidth}
              $windowHeight={windowHeight}
            >
              <StyledGridInputs>
                {range(0, rows).map((y) =>
                  range(0, cols).map((x) => {
                    const idx = cols * y + x
                    const { streamId } = sharedState?.views?.[idx] ?? {}
                    const isMoveHighlight =
                      moveStart != null &&
                      moveTargetIdx != null &&
                      moveStart.idx !== moveTargetIdx &&
                      (
                        stateIdxMap.get(moveTargetIdx)?.spaces ?? [
                          moveTargetIdx,
                        ]
                      ).includes(idx)
                    const isResizeHighlight =
                      resize != null &&
                      hoveringIdx != null &&
                      isIdxInResizeBox(
                        cols,
                        resize.anchorIdx,
                        hoveringIdx,
                        resize.handle,
                        resize.originalSpaces,
                        idx,
                      )
                    const isHighlighted = isMoveHighlight || isResizeHighlight
                    return (
                      <GridInput
                        style={{
                          width: `${100 / cols}%`,
                          height: `${100 / rows}%`,
                          left: `${(100 * x) / cols}%`,
                          top: `${(100 * y) / rows}%`,
                        }}
                        idx={idx}
                        spaceValue={streamId ?? ''}
                        onChangeSpace={handleSetView}
                        isHighlighted={isHighlighted}
                        role={role}
                        onPointerDown={handleGridPointerDown}
                        onFocus={setFocusedInputIdx}
                        onBlur={handleBlurInput}
                      />
                    )
                  }),
                )}
              </StyledGridInputs>
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                }}
              >
                {views.map(({ state }) => {
                  const { pos } = state.context
                  if (pos == null) {
                    return null
                  }
                  const anchorIdx = Math.min(...pos.spaces)
                  return (
                    <div
                      key={`rh-${anchorIdx}`}
                      style={{
                        position: 'absolute',
                        left: `${(100 * pos.x) / windowWidth}%`,
                        top: `${(100 * pos.y) / windowHeight}%`,
                        width: `${(100 * pos.width) / windowWidth}%`,
                        height: `${(100 * pos.height) / windowHeight}%`,
                        pointerEvents: 'none',
                      }}
                    >
                      <StyledResizeHandles>
                        <div
                          className="handle e"
                          onPointerDown={(ev) =>
                            handleResizeStart(anchorIdx, 'e', pos.spaces, ev)
                          }
                        />
                        <div
                          className="handle s"
                          onPointerDown={(ev) =>
                            handleResizeStart(anchorIdx, 's', pos.spaces, ev)
                          }
                        />
                        <div
                          className="handle se"
                          onPointerDown={(ev) =>
                            handleResizeStart(anchorIdx, 'se', pos.spaces, ev)
                          }
                        />
                      </StyledResizeHandles>
                    </div>
                  )
                })}
              </div>
              <StyledGridPreview>
                {views.map(({ state, isListening }) => {
                  const { pos } = state.context
                  if (pos == null) {
                    return null
                  }

                  const { streamId } = sharedState?.views[pos.spaces[0]] ?? {}
                  const data = streams.find((d) => d._id === streamId)
                  if (streamId == null || data == null) {
                    return null
                  }

                  const isSmall = pos.height < 200
                  const isError = matchesState('displaying.error', state.state)
                  const errorReason = state.context.error
                  return (
                    <GridPreviewBox
                      streamId={streamId}
                      color={idColor(streamId)}
                      style={{
                        left: `${(100 * pos.x) / windowWidth}%`,
                        top: `${(100 * pos.y) / windowHeight}%`,
                        width: `${(100 * pos.width) / windowWidth}%`,
                        height: `${(100 * pos.height) / windowHeight}%`,
                      }}
                      pos={pos}
                      windowWidth={windowWidth}
                      windowHeight={windowHeight}
                      isListening={isListening}
                      isSmall={isSmall}
                      isError={isError}
                      errorReason={errorReason}
                      orientation={data?.orientation ?? null}
                      source={data?.source}
                      city={data?.city}
                      state={data?.state}
                    />
                  )
                })}
              </StyledGridPreview>
              {views.map(
                ({
                  state,
                  isListening,
                  isBackgroundListening,
                  isBlurred,
                  volume,
                }) => {
                  const { pos } = state.context
                  if (!pos) {
                    return null
                  }
                  const { streamId } = sharedState?.views[pos.spaces[0]] ?? {}
                  if (!streamId) {
                    return null
                  }
                  return (
                    <GridControls
                      idx={pos.spaces[0]}
                      streamId={streamId}
                      style={{
                        left: `${(100 * pos.x) / windowWidth}%`,
                        top: `${(100 * pos.y) / windowHeight}%`,
                        width: `${(100 * pos.width) / windowWidth}%`,
                        height: `${(100 * pos.height) / windowHeight}%`,
                      }}
                      isDisplaying={matchesState('displaying', state.state)}
                      isListening={isListening}
                      isBackgroundListening={isBackgroundListening}
                      isBlurred={isBlurred}
                      volume={volume}
                      isSwapping={
                        swapStartIdx != null &&
                        pos.spaces.includes(swapStartIdx)
                      }
                      showDebug={showDebug}
                      role={role}
                      onSetListening={handleSetListening}
                      onSetBackgroundListening={handleSetBackgroundListening}
                      onSetBlurred={handleSetBlurred}
                      onSetVolume={handleSetVolume}
                      onReloadView={handleReloadView}
                      onSwapView={handleSwapView}
                      onRotateView={handleRotateStream}
                      onBrowse={handleBrowse}
                      onDevTools={handleDevTools}
                      onPointerDown={handleGridPointerDown}
                    />
                  )
                },
              )}
            </StyledGridContainer>
          )}
        </StyledDataContainer>
        <StyledStatusBar>
          {(roleCan(role, 'dev-tools') || roleCan(role, 'browse')) && (
            <label className="dbg">
              <input
                type="checkbox"
                checked={showDebug}
                onChange={handleChangeShowDebug}
              />
              Debug-Tools
            </label>
          )}
          <span className="spacer" />
          <span className="meta">
            {streams.length} Quellen · {liveStreams.length} live
          </span>
        </StyledStatusBar>
      </Stack>
      <Stack className="stream-list" $scroll={true} $minHeight={200}>
        <StyledDataContainer $isConnected={isConnected}>
          {isConnected ? (
            <div>
              <input
                className="filter-input"
                onChange={handleStreamFilterChange}
                value={streamFilter}
                placeholder="Quellen filtern…"
              />
              <h3>
                Viewing <span className="ct">{wallStreams.length}</span>
              </h3>
              <StreamList rows={wallStreams} />
              <h3>
                Live <span className="ct">{liveStreams.length}</span>
              </h3>
              <StreamList rows={liveStreams} />
              <h3>
                Offline / Unknown{' '}
                <span className="ct">{otherStreams.length}</span>
              </h3>
              <StreamList rows={otherStreams} />
            </div>
          ) : (
            <div>loading...</div>
          )}
          {roleCan(role, 'update-custom-stream') &&
            roleCan(role, 'delete-custom-stream') && (
              <>
                <h2>Custom Streams</h2>
                <div>
                  {/*
                    Include an empty object at the end to create an extra input for a new custom stream.
                    We need it to be part of the array (rather than JSX below) for DOM diffing to match the key and retain focus.
                  */}
                  {customStreams.map(({ link, label, kind }, idx) => (
                    <CustomStreamInput
                      key={idx}
                      link={link}
                      label={label}
                      kind={kind}
                      onChange={handleChangeCustomStream}
                      onDelete={handleDeleteCustomStream}
                    />
                  ))}
                  <CreateCustomStreamInput
                    onCreate={handleChangeCustomStream}
                  />
                </div>
              </>
            )}
          {(roleCan(role, 'create-invite') || roleCan(role, 'delete-token')) &&
            authState && (
              <>
                <h2>Access</h2>
                <div>
                  <CreateInviteInput onCreateInvite={handleCreateInvite} />
                  <h3>Invites</h3>
                  {newInvite && (
                    <StyledNewInviteBox>
                      Invite link created:{' '}
                      <a
                        href={inviteLink({
                          tokenId: newInvite.tokenId,
                          secret: newInvite.secret,
                        })}
                        onClick={preventLinkClick}
                      >
                        "{newInvite.name}"
                      </a>
                    </StyledNewInviteBox>
                  )}
                  {authState.invites.map(({ tokenId, name, role }) => (
                    <AuthTokenLine
                      id={tokenId}
                      name={name}
                      role={role}
                      onDelete={handleDeleteToken}
                    />
                  ))}
                  <h3>Sessions</h3>
                  {authState.sessions.map(({ tokenId, name, role }) => (
                    <AuthTokenLine
                      id={tokenId}
                      name={name}
                      role={role}
                      onDelete={handleDeleteToken}
                    />
                  ))}
                </div>
              </>
            )}
        </StyledDataContainer>
      </Stack>
    </AppShell>
  )
}

const Stack = styled.div<{
  $direction?: string
  $flex?: string
  $gap?: number
  $scroll?: boolean
  $minHeight?: number
}>`
  display: flex;
  flex-direction: ${({ $direction }) => $direction ?? 'column'};
  flex: ${({ $flex }) => $flex};
  ${({ $gap }) => $gap && `gap: ${$gap}px`};
  ${({ $scroll }) => $scroll && `overflow-y: auto`};
  ${({ $minHeight }) => $minHeight && `min-height: ${$minHeight}px`};
`

// Below this viewport width the side-by-side wall/stream-list layout stops
// fitting, so the shell stacks the two regions vertically instead (see #81).
// Shared with the header so both switch to their narrow layout together.
const NARROW_BREAKPOINT = 820

// Root layout. Desktop: the wall preview and the stream list sit side by side,
// pinned to the viewport height with only the stream list scrolling. Narrow
// screens (phones, small windows): the two regions stack and the whole page
// scrolls. Layout that the media query needs to override lives here rather than
// as inline styles on the children so the cascade can win cleanly.
const AppShell = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  gap: 16px;
  height: 100vh;
  min-height: 0;
  padding: 16px;
  overflow: hidden;

  > .grid-container {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  > .stream-list {
    flex: 0 0 340px;
  }

  @media (max-width: ${NARROW_BREAKPOINT}px) {
    flex-direction: column;
    height: auto;
    min-height: 100vh;
    overflow: visible;

    /* Stack both regions at their natural height and let the whole page
       scroll, rather than pinning them to the viewport and competing for its
       height (which collapses the wall region to nothing). */
    > .grid-container {
      flex: 0 0 auto;
    }

    > .stream-list {
      flex: 0 0 auto;
      min-width: 0;
      overflow-y: visible;
    }
  }
`

function StreamDurationClock({ startTime }: { startTime: number }) {
  const [now, setNow] = useState(() => DateTime.now())
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(DateTime.now())
    }, 500)
    return () => {
      clearInterval(interval)
    }
  }, [startTime])
  return (
    <span>{now.diff(DateTime.fromMillis(startTime)).toFormat('hh:mm:ss')}</span>
  )
}

function StreamDelayBox({
  role,
  delayState,
  setStreamCensored,
  setStreamRunning,
}: {
  role: StreamwallRole | null
  delayState: StreamDelayStatus
  setStreamCensored: (isCensored: boolean) => void
  setStreamRunning: (isStreamRunning: boolean) => void
}) {
  const handleToggleStreamCensored = useCallback(() => {
    setStreamCensored(!delayState.isCensored)
  }, [delayState.isCensored, setStreamCensored])
  const handleToggleStreamRunning = useCallback(() => {
    if (!delayState.isStreamRunning || confirm('End stream?')) {
      setStreamRunning(!delayState.isStreamRunning)
    }
  }, [delayState.isStreamRunning, setStreamRunning])
  let buttonText
  if (delayState.isConnected) {
    if (matchesState('censorship.censored.deactivating', delayState.state)) {
      buttonText = 'Deactivating...'
    } else if (delayState.isCensored) {
      buttonText = 'Uncensor stream'
    } else {
      buttonText = 'Censor stream'
    }
  }
  return (
    <div>
      <StyledStreamDelayBox>
        <strong>Streamdelay</strong>
        {!delayState.isConnected && <span>connecting...</span>}
        {!delayState.isStreamRunning && <span>stream stopped</span>}
        {delayState.isConnected && (
          <>
            {delayState.startTime !== null && (
              <StreamDurationClock startTime={delayState.startTime} />
            )}
            <span>delay: {delayState.delaySeconds}s</span>
            {delayState.isStreamRunning && (
              <StyledButton
                $isActive={delayState.isCensored}
                onClick={handleToggleStreamCensored}
                tabIndex={1}
              >
                {buttonText}
              </StyledButton>
            )}
            {roleCan(role, 'set-stream-running') && (
              <StyledButton onClick={handleToggleStreamRunning} tabIndex={1}>
                {delayState.isStreamRunning ? 'End stream' : 'Start stream'}
              </StyledButton>
            )}
          </>
        )}
      </StyledStreamDelayBox>
    </div>
  )
}

function OrientationIndicator({
  orientation,
  className,
}: {
  orientation: 'V' | 'H' | null | undefined
  className?: string
}) {
  if (orientation === 'V') {
    return (
      <span className={className}>
        <MdOutlineStayCurrentPortrait />
      </span>
    )
  } else if (orientation === 'H') {
    return (
      <span className={className}>
        <MdOutlineStayCurrentLandscape />
      </span>
    )
  } else {
    return null
  }
}

// Extracted from the ControlUI grid preview loop so the error badge markup
// can be rendered and tested in isolation.
export function GridPreviewBox({
  streamId,
  color,
  pos,
  windowWidth,
  windowHeight,
  isListening,
  isSmall,
  isError,
  errorReason,
  orientation,
  source,
  city,
  state,
  style,
}: {
  streamId: string
  color: ColorInstance
  pos: ViewPos
  windowWidth: number
  windowHeight: number
  isListening: boolean
  isSmall: boolean
  isError: boolean
  errorReason: string | null | undefined
  orientation: 'V' | 'H' | null | undefined
  source: string | undefined
  city: string | undefined
  state: string | undefined
  style?: JSX.HTMLAttributes['style']
}) {
  const hotkeyLabel = getHotkeyLabel(pos.spaces[0])
  return (
    <StyledGridPreviewBox
      $color={color}
      style={style}
      $pos={pos}
      $windowWidth={windowWidth}
      $windowHeight={windowHeight}
      $isListening={isListening}
      $isError={isError}
      title={hotkeyLabel ? `${hotkeyLabel} toggles audio` : undefined}
    >
      <StyledGridInfo className={isSmall ? 'small' : undefined}>
        <StyledGridLabel>
          {streamId}
          <OrientationIndicator
            orientation={orientation}
            className={`orientation-${(orientation ?? 'unknown').toLowerCase()}`}
          />
        </StyledGridLabel>
        {!isSmall && <div>{source}</div>}
        {city && (
          <StyledGridLocation>
            {city} {state}
          </StyledGridLocation>
        )}
        {isError && (
          <StyledGridError title={errorReason ?? undefined}>
            <FaExclamationTriangle />
            <span>{errorReason ?? 'Stream error'}</span>
          </StyledGridError>
        )}
      </StyledGridInfo>
    </StyledGridPreviewBox>
  )
}

function StreamLine({
  id,
  row: { label, source, link, notes, city, state, orientation },
  disabled,
  onClickId,
}: {
  id: string
  row: StreamData
  disabled: boolean
  onClickId: (id: string) => void
}) {
  // Use mousedown instead of click event so a potential destination grid input stays focused.
  const handleMouseDownId = useCallback(() => {
    onClickId(id)
  }, [onClickId, id])
  return (
    <StyledStreamLine>
      <StyledId
        $disabled={disabled}
        onMouseDown={disabled ? undefined : handleMouseDownId}
        $color={idColor(id)}
      >
        {id}
      </StyledId>
      <div>
        {label ? (
          label
        ) : (
          <>
            <strong>{source}</strong>{' '}
            <OrientationIndicator orientation={orientation} />{' '}
            {city ? `(${city} ${state}) ` : ''}
            <a href={link} target="_blank">
              {truncate(link, { length: 55 })}
            </a>{' '}
            {notes}
          </>
        )}
      </div>
    </StyledStreamLine>
  )
}

const StyledResizeHandles = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: none;

  .handle {
    position: absolute;
    pointer-events: auto;
    touch-action: none;
    background: var(--accent, #e23);
    opacity: 0;
    transition: opacity 0.1s;
  }
  &:hover .handle {
    opacity: 0.6;
  }
  /* Touch/pen devices have no hover state to reveal the handles, so keep
     them visible without it — otherwise they're impossible to find. */
  @media (hover: none), (pointer: coarse) {
    .handle {
      opacity: 0.6;
    }
  }
  .handle.e {
    top: 20%;
    bottom: 20%;
    right: -3px;
    width: 6px;
    cursor: ew-resize;
  }
  .handle.s {
    left: 20%;
    right: 20%;
    bottom: -3px;
    height: 6px;
    cursor: ns-resize;
  }
  .handle.se {
    right: -4px;
    bottom: -4px;
    width: 10px;
    height: 10px;
    cursor: nwse-resize;
    opacity: 0.8;
    border-radius: 2px;
  }
`

const StyledGridSizeControls = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;

  button.preset {
    padding: 2px 8px;
    border: 1px solid var(--border, #444);
    background: transparent;
    color: inherit;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  button.preset.active {
    border-color: var(--accent, #e23);
    color: var(--accent, #e23);
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  input {
    width: 44px;
    background: transparent;
    color: inherit;
    border: 1px solid var(--border, #444);
    border-radius: 4px;
    padding: 2px 4px;
  }
`

const GRID_PRESETS: Array<[number, number]> = [
  [2, 2],
  [3, 3],
  [4, 4],
  [2, 3],
  [3, 2],
  [4, 3],
]

function GridSizeControls({
  cols,
  rows,
  role,
  onSetGridSize,
}: {
  cols: number
  rows: number
  role: StreamwallRole | null
  onSetGridSize: (cols: number, rows: number) => void
}) {
  const disabled = !roleCan(role, 'mutate-state-doc')

  // The inputs hold a local draft while the user types so that transient
  // states (an empty or out-of-range field) never reach the grid. The change
  // is committed only on blur/Enter, and only when it parses to a valid,
  // in-range dimension — otherwise the field reverts to the authoritative
  // value. This prevents a cleared field (NaN) from collapsing the wall.
  const [colsDraft, setColsDraft] = useState(String(cols))
  const [rowsDraft, setRowsDraft] = useState(String(rows))
  useEffect(() => setColsDraft(String(cols)), [cols])
  useEffect(() => setRowsDraft(String(rows)), [rows])

  const commitCols = useCallback(
    (raw: string) => {
      const parsed = parseGridDimensionInput(raw)
      if (parsed !== null && parsed !== cols) {
        onSetGridSize(parsed, rows)
      }
      setColsDraft(String(cols))
    },
    [cols, rows, onSetGridSize],
  )
  const commitRows = useCallback(
    (raw: string) => {
      const parsed = parseGridDimensionInput(raw)
      if (parsed !== null && parsed !== rows) {
        onSetGridSize(cols, parsed)
      }
      setRowsDraft(String(rows))
    },
    [cols, rows, onSetGridSize],
  )

  const commitOnEnter: JSX.KeyboardEventHandler<HTMLInputElement> = (ev) => {
    if (ev.key === 'Enter') {
      ev.currentTarget.blur()
    }
  }

  return (
    <StyledGridSizeControls>
      {GRID_PRESETS.map(([c, r]) => (
        <button
          key={`${c}x${r}`}
          type="button"
          className={c === cols && r === rows ? 'preset active' : 'preset'}
          disabled={disabled}
          onClick={() => onSetGridSize(c, r)}
        >
          {c}×{r}
        </button>
      ))}
      <label>
        Columns
        <input
          type="number"
          min={GRID_MIN}
          max={GRID_MAX}
          value={colsDraft}
          disabled={disabled}
          onInput={(ev) => setColsDraft(ev.currentTarget.value)}
          onBlur={(ev) => commitCols(ev.currentTarget.value)}
          onKeyDown={commitOnEnter}
        />
      </label>
      <label>
        Rows
        <input
          type="number"
          min={GRID_MIN}
          max={GRID_MAX}
          value={rowsDraft}
          disabled={disabled}
          onInput={(ev) => setRowsDraft(ev.currentTarget.value)}
          onBlur={(ev) => commitRows(ev.currentTarget.value)}
          onKeyDown={commitOnEnter}
        />
      </label>
    </StyledGridSizeControls>
  )
}

export function GridInput({
  style,
  idx,
  onChangeSpace,
  spaceValue,
  isHighlighted,
  role,
  onPointerDown,
  onFocus,
  onBlur,
}: {
  style: JSX.HTMLAttributes['style']
  onPointerDown: JSX.PointerEventHandler<HTMLInputElement>
  idx: number
  onChangeSpace: (idx: number, value: string) => void
  spaceValue: string
  isHighlighted: boolean
  role: StreamwallRole | null
  onFocus: (idx: number) => void
  onBlur: (idx: number) => void
}) {
  const handleFocus = useCallback(() => {
    onFocus(idx)
  }, [onFocus, idx])
  const handleBlur = useCallback(() => {
    onBlur(idx)
  }, [onBlur, idx])
  const handleChange = useCallback(
    (value: string) => {
      onChangeSpace(idx, value)
    },
    [idx, onChangeSpace],
  )
  return (
    <StyledGridInputContainer style={style}>
      <StyledGridInput
        value={spaceValue}
        $color={idColor(spaceValue)}
        $isHighlighted={isHighlighted}
        disabled={!roleCan(role, 'mutate-state-doc')}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onPointerDown={onPointerDown}
        onChange={handleChange}
        isEager
      />
    </StyledGridInputContainer>
  )
}

export function GridControls({
  idx,
  streamId,
  style,
  isDisplaying,
  isListening,
  isBackgroundListening,
  isBlurred,
  volume,
  isSwapping,
  showDebug,
  role,
  onSetListening,
  onSetBackgroundListening,
  onSetBlurred,
  onSetVolume,
  onReloadView,
  onSwapView,
  onRotateView,
  onBrowse,
  onDevTools,
  onPointerDown,
}: {
  idx: number
  streamId: string
  style: JSX.HTMLAttributes['style']
  isDisplaying: boolean
  isListening: boolean
  isBackgroundListening: boolean
  isBlurred: boolean
  volume: number
  isSwapping: boolean
  showDebug: boolean
  role: StreamwallRole | null
  onSetListening: (idx: number, isListening: boolean) => void
  onSetBackgroundListening: (
    idx: number,
    isBackgroundListening: boolean,
  ) => void
  onSetBlurred: (idx: number, isBlurred: boolean) => void
  onSetVolume: (idx: number, volume: number) => void
  onReloadView: (idx: number) => void
  onSwapView: (idx: number) => void
  onRotateView: (streamId: string) => void
  onBrowse: (streamId: string) => void
  onDevTools: (idx: number) => void
  onPointerDown: JSX.PointerEventHandler<HTMLDivElement>
}) {
  // TODO: Refactor callbacks to use streamID instead of idx.
  // We should probably also switch the view-state-changing RPCs to use a view id instead of idx like they do currently.
  const handleListeningClick = useCallback<
    JSX.MouseEventHandler<HTMLButtonElement>
  >(
    (ev) =>
      ev.shiftKey || isBackgroundListening
        ? onSetBackgroundListening(idx, !isBackgroundListening)
        : onSetListening(idx, !isListening),
    [
      idx,
      onSetListening,
      onSetBackgroundListening,
      isListening,
      isBackgroundListening,
    ],
  )
  const handleBlurClick = useCallback(
    () => onSetBlurred(idx, !isBlurred),
    [idx, onSetBlurred, isBlurred],
  )
  const handleVolumeInput = useCallback<
    JSX.InputEventHandler<HTMLInputElement>
  >(
    (ev) => onSetVolume(idx, Number(ev.currentTarget.value)),
    [idx, onSetVolume],
  )
  const handleReloadClick = useCallback(
    () => onReloadView(idx),
    [idx, onReloadView],
  )
  const handleSwapClick = useCallback(() => onSwapView(idx), [idx, onSwapView])
  const handleRotateClick = useCallback(
    () => onRotateView(streamId),
    [streamId, onRotateView],
  )
  const handleBrowseClick = useCallback(
    () => onBrowse(streamId),
    [streamId, onBrowse],
  )
  const handleDevToolsClick = useCallback(
    () => onDevTools(idx),
    [idx, onDevTools],
  )
  return (
    <StyledGridControlsContainer style={style} onPointerDown={onPointerDown}>
      {isDisplaying && (
        <StyledGridButtons $side="left">
          {showDebug ? (
            <>
              {roleCan(role, 'reload-view') && (
                <StyledSmallButton onClick={handleReloadClick} tabIndex={1}>
                  <FaSyncAlt />
                </StyledSmallButton>
              )}
              {roleCan(role, 'browse') && (
                <StyledSmallButton onClick={handleBrowseClick} tabIndex={1}>
                  <FaRegWindowMaximize />
                </StyledSmallButton>
              )}
              {roleCan(role, 'dev-tools') && (
                <StyledSmallButton onClick={handleDevToolsClick} tabIndex={1}>
                  <FaRegLifeRing />
                </StyledSmallButton>
              )}
            </>
          ) : (
            <>
              {roleCan(role, 'reload-view') && (
                <StyledSmallButton onClick={handleReloadClick} tabIndex={1}>
                  <FaSyncAlt />
                </StyledSmallButton>
              )}
              {roleCan(role, 'mutate-state-doc') && (
                <StyledSmallButton
                  $isActive={isSwapping}
                  onClick={handleSwapClick}
                  tabIndex={1}
                >
                  <FaExchangeAlt />
                </StyledSmallButton>
              )}
              {roleCan(role, 'rotate-stream') && (
                <StyledSmallButton onClick={handleRotateClick} tabIndex={1}>
                  <FaRedoAlt />
                </StyledSmallButton>
              )}
            </>
          )}
        </StyledGridButtons>
      )}
      <StyledGridButtons $side="right">
        {roleCan(role, 'set-view-blurred') && (
          <StyledButton
            $isActive={isBlurred}
            onClick={handleBlurClick}
            tabIndex={1}
          >
            <FaVideoSlash />
          </StyledButton>
        )}
        {roleCan(role, 'set-view-volume') && (
          <StyledVolumeSlider
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onInput={handleVolumeInput}
            tabIndex={1}
            aria-label="Volume"
          />
        )}
        {roleCan(role, 'set-listening-view') && (
          <StyledButton
            $isActive={isListening || isBackgroundListening}
            $activeColor={
              isListening ? 'red' : Color('red').desaturate(0.5).hsl().string()
            }
            onClick={handleListeningClick}
            tabIndex={1}
          >
            <FaVolumeUp />
          </StyledButton>
        )}
      </StyledGridButtons>
    </StyledGridControlsContainer>
  )
}

function CustomStreamInput({
  onChange,
  onDelete,
  ...props
}: {
  onChange: (link: string, data: LocalStreamData) => void
  onDelete: (link: string) => void
} & LocalStreamData) {
  const handleChangeLabel = useCallback(
    (value: string) => {
      onChange(props.link, { ...props, label: value })
    },
    [onChange, props],
  )

  const handleDeleteClick = useCallback(() => {
    onDelete(props.link)
  }, [onDelete, props.link])

  return (
    <div>
      <LazyChangeInput
        value={props.label ?? ''}
        onChange={handleChangeLabel}
        placeholder="Label (optional)"
      />{' '}
      <a href={props.link}>{props.link}</a> <span>({props.kind})</span>{' '}
      <button onClick={handleDeleteClick}>x</button>
    </div>
  )
}

function CreateCustomStreamInput({
  onCreate,
}: {
  onCreate: (link: string, data: LocalStreamData) => void
}) {
  const [link, setLink] = useState('')
  const [kind, setKind] = useState<ContentKind>('video')
  const [label, setLabel] = useState('')
  const handleSubmit = useCallback<JSX.SubmitEventHandler<HTMLFormElement>>(
    (ev) => {
      ev.preventDefault()
      onCreate(link, { link, kind, label })
      setLink('')
      setKind('video')
      setLabel('')
    },
    [onCreate, link, kind, label],
  )
  return (
    <form onSubmit={handleSubmit}>
      <input
        value={link}
        onChange={(ev) => setLink(ev.currentTarget.value)}
        placeholder="https://..."
      />
      <select
        onChange={(ev) => setKind(ev.currentTarget.value as ContentKind)}
        value={kind}
      >
        <option value="video">video</option>
        <option value="audio">audio</option>
        <option value="web">web</option>
        <option value="overlay">overlay</option>
        <option value="background">background</option>
      </select>
      <input
        value={label}
        onChange={(ev) => setLabel(ev.currentTarget.value)}
        placeholder="Label (optional)"
      />
      <button type="submit">add stream</button>
    </form>
  )
}

const StyledHeader = styled.header`
  display: flex;
  align-items: center;
  gap: 18px;
  flex: 0 0 auto;
  position: relative;
  padding: 4px 2px 14px;
  margin-bottom: 14px;

  /* Stencil-editorial anchor: a red rule that runs out into the border line. */
  &::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: linear-gradient(
      90deg,
      var(--accent) 0 132px,
      var(--border) 132px
    );
  }

  .wm {
    font-family: var(--font-display);
    font-size: 27px;
    line-height: 1;
    letter-spacing: 0.03em;
    color: var(--text);
    white-space: nowrap;
  }
  .wm span {
    color: var(--accent);
  }

  .crumbs {
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  .crumbs b {
    color: var(--text-dim);
    font-weight: 500;
  }

  .spacer {
    flex: 1;
  }

  .livecount {
    font-family: 'Oswald', var(--font-ui);
    text-transform: uppercase;
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.12em;
    color: var(--accent);
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    padding: 5px 11px;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 7px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .status .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .status .dot.on {
    background: var(--ok);
  }
  .status .dot.off {
    background: var(--text-faint);
  }

  /* On narrow screens the header controls no longer fit on one line - let them
     wrap instead of overflowing the viewport (see #81). */
  @media (max-width: ${NARROW_BREAKPOINT}px) {
    flex-wrap: wrap;
    gap: 10px 14px;
  }
`

const StyledStreamDelayBox = styled.div`
  display: inline-flex;
  align-items: center;
  margin: 5px 0;
  padding: 10px 12px;
  gap: 1em;
  border-radius: var(--r-md);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  color: var(--text);
`

const StyledDataContainer = styled.div<{ $isConnected?: boolean }>`
  opacity: ${({ $isConnected }) => ($isConnected ? 1 : 0.5)};
`

const StyledButton = styled.button<{
  $isActive?: boolean
  $activeColor?: string
}>`
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-2);
  background: var(--surface-3);
  color: var(--text-dim);
  border-radius: var(--r-sm);
  padding: 4px;
  cursor: pointer;

  &:hover {
    color: var(--text);
    border-color: var(--text-faint);
  }

  ${({ $isActive, $activeColor = 'red' }) =>
    $isActive &&
    `
      border-color: ${Color($activeColor).hsl().string()};
      background: ${Color($activeColor).hsl().string()};
      color: #fff;
    `};

  &:focus {
    outline: none;
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  svg {
    width: 20px;
    height: 20px;
  }
`

const StyledSmallButton = styled(StyledButton)`
  svg {
    width: 14px;
    height: 14px;
  }
`

const StyledVolumeSlider = styled.input`
  width: 54px;
  height: 24px;
  margin: 5px;
  accent-color: var(--accent-2);
  cursor: pointer;
`

const StyledGridPreview = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
`

const StyledGridInfo = styled.div`
  text-align: center;
  padding: 8px;
  border-radius: 16px;
  pointer-events: none;
  z-index: 1000; /* Keep above grid inputs */
`

const StyledGridPreviewBox = styled.div.attrs<{
  $color: ColorInstance
  $isError: boolean
  $pos: ViewPos
  $windowWidth: number
  $windowHeight: number
  $isListening: boolean
  $borderWidth?: number
}>(() => ({
  $borderWidth: 2,
}))`
  display: flex;
  align-items: center;
  justify-content: center;
  position: absolute;
  background: ${({ $color }) =>
    Color($color).lightness(50).hsl().string() || '#333'};
  border: 0 solid
    ${({ $isError }) =>
      $isError ? Color('red').hsl().string() : Color('black').hsl().string()};
  border-left-width: ${({ $pos, $borderWidth }) =>
    $pos.x === 0 ? 0 : $borderWidth}px;
  border-right-width: ${({ $pos, $borderWidth, $windowWidth }) =>
    $pos.x + $pos.width === $windowWidth ? 0 : $borderWidth}px;
  border-top-width: ${({ $pos, $borderWidth }) =>
    $pos.y === 0 ? 0 : $borderWidth}px;
  border-bottom-width: ${({ $pos, $borderWidth, $windowHeight }) =>
    $pos.y + $pos.height === $windowHeight ? 0 : $borderWidth}px;
  box-shadow: ${({ $isListening }) =>
    $isListening ? `0 0 0 4px red inset` : 'none'};
  box-sizing: border-box;
  overflow: hidden;
  user-select: none;

  ${StyledGridInfo} {
    background: ${({ $color }) =>
      Color($color).lightness(50).hsl().string() || '#333'};
  }
`

const StyledGridLabel = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 30px;

  .orientation-v {
    margin-left: -4px;
  }

  ${StyledGridInfo}.small & {
    font-size: 20px;
  }
`

const StyledGridLocation = styled.div`
  font-size: 13px;
  opacity: 0.75;
`

const StyledGridError = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin-top: 6px;
  padding: 3px 8px;
  border-radius: 8px;
  max-width: 100%;
  font-size: 12px;
  font-weight: 600;
  color: white;
  background: ${Color('red').alpha(0.7).string()};

  svg {
    flex-shrink: 0;
  }

  span {
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }

  ${StyledGridInfo}.small & {
    span {
      display: none;
    }
  }
`

const StyledGridInputs = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity 100ms ease-out;
  overflow: hidden;
  z-index: 100;
`

const StyledGridInputContainer = styled.div`
  position: absolute;
  touch-action: none;
`

const StyledGridButtons = styled.div<{ $side?: 'left' | 'right' }>`
  display: flex;
  position: absolute;
  ${({ $side }) =>
    $side === 'left' ? 'top: 0; left: 0' : 'bottom: 0; right: 0'};

  ${StyledButton} {
    margin: 5px;
    ${({ $side }) => ($side === 'left' ? 'margin-right: 0' : 'margin-left: 0')};
  }
`

const StyledGridInput = styled(LazyChangeInput)<{
  $color: ColorInstance
  $isHighlighted?: boolean
}>`
  width: 100%;
  height: 100%;
  outline: 1px solid rgba(0, 0, 0, 0.5);
  border: none;
  padding: 0;
  background: ${({ $color, $isHighlighted }) =>
    $isHighlighted
      ? Color($color).lightness(90).hsl().string()
      : Color($color).lightness(75).hsl().string()};
  font-size: 20px;
  text-align: center;

  &:focus {
    outline: 1px solid black;
    box-shadow: 0 0 5px black inset;
    z-index: 100;
  }
`

const StyledGridControlsContainer = styled.div`
  position: absolute;
  user-select: none;
  touch-action: none;

  & > * {
    z-index: 1001; // Above StyledGridInfo
  }
`

const StyledGridContainer = styled.div<{
  $windowWidth: number
  $windowHeight: number
}>`
  position: relative;
  /* Responsive: keep the wall's aspect ratio but fit the available space
     instead of a hard-coded pixel size, so the layout never overflows. */
  aspect-ratio: ${({ $windowWidth, $windowHeight }) =>
    `${$windowWidth} / ${$windowHeight}`};
  width: 100%;
  max-height: 100%;
  margin: 0 auto;
  border: 1px solid var(--border-2);
  border-radius: var(--r-md);
  background: var(--cell-bg);
  overflow: hidden;

  &:hover ${StyledGridInputs} {
    opacity: 0.35;
  }
`

const StyledId = styled.div<{ $color: ColorInstance; $disabled?: boolean }>`
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.02em;
  background: ${({ $color }) =>
    Color($color).lightness(52).hsl().string() || '#333'};
  color: #0a0d12;
  padding: 4px 0;
  border-radius: var(--r-sm);
  width: 2.6em;
  text-align: center;
  cursor: ${({ $disabled }) => ($disabled ? 'normal' : 'grab')};
`

const StyledStreamLine = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: var(--r-sm);
  border: 1px solid transparent;
  font-size: 13px;
  cursor: default;

  &:hover {
    background: var(--surface-2);
    border-color: var(--border);
  }

  & > div {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }

  svg {
    height: 100%;
  }
`

function CreateInviteInput({
  onCreateInvite,
}: {
  onCreateInvite: (invite: { name: string; role: StreamwallRole }) => void
}) {
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState('operator')
  const handleChangeName = useCallback<JSX.InputEventHandler<HTMLInputElement>>(
    (ev) => {
      setInviteName(ev.currentTarget.value)
    },
    [setInviteName],
  )
  const handleChangeRole = useCallback<
    JSX.InputEventHandler<HTMLSelectElement>
  >(
    (ev) => {
      setInviteRole(ev.currentTarget.value)
    },
    [setInviteRole],
  )
  const handleSubmit = useCallback<JSX.SubmitEventHandler<HTMLFormElement>>(
    (ev) => {
      ev.preventDefault()
      setInviteName('')
      setInviteRole('operator')
      onCreateInvite({ name: inviteName, role: inviteRole as StreamwallRole }) // TODO: validate
    },
    [onCreateInvite, inviteName, inviteRole],
  )
  return (
    <div>
      <form onSubmit={handleSubmit}>
        <input
          onChange={handleChangeName}
          placeholder="Name"
          value={inviteName}
        />
        <select onChange={handleChangeRole} value={inviteRole}>
          <option value="admin">admin</option>
          <option value="operator">operator</option>
          <option value="monitor">monitor</option>
        </select>
        <button type="submit">create invite</button>
      </form>
    </div>
  )
}

const StyledNewInviteBox = styled.div`
  display: block;
  padding: 10px 12px;
  margin: 8px 0;
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent);
  color: var(--text);
  font-size: 13px;
`

function AuthTokenLine({
  id,
  role,
  name,
  onDelete,
}: {
  id: string
  role: StreamwallRole
  name: string
  onDelete: (id: string) => void
}) {
  const handleDeleteClick = useCallback(() => {
    onDelete(id)
  }, [id, onDelete])
  return (
    <div>
      <strong>{name}</strong>: {role}{' '}
      <button onClick={handleDeleteClick}>revoke</button>
    </div>
  )
}

const StyledStatusBar = styled.div`
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 0 0 auto;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);

  .spacer {
    flex: 1;
  }

  .meta {
    color: var(--text-faint);
  }

  label.dbg {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  label.dbg input {
    accent-color: var(--accent);
  }
`

// TODO: reuse for server
/*
export function main() {
  const script = document.getElementById('main-script')
  const wsEndpoint =
    typeof script?.dataset?.wsEndpoint === 'string'
      ? script.dataset.wsEndpoint
      : 'defaultWsEndpoint'
  const role =
    typeof script?.dataset?.role === 'string'
      ? (script.dataset.role as StreamwallRole)
      : null

  render(
    <>
      <GlobalStyle />
      <App wsEndpoint={wsEndpoint} role={role} />
    </>,
    document.body,
  )
}
*/
