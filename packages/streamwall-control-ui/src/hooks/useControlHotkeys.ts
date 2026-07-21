import { useCallback } from 'preact/hooks'
import { useHotkeys } from 'react-hotkeys-hook'
import { roleCan, type StreamwallRole } from 'streamwall-shared'
import type * as Y from 'yjs'
import {
  blurHotkeyLayerBindings,
  hotkeyLayerBindings,
  hotkeyTriggers,
} from '../hotkeyLabel.ts'
import { type ViewInfo } from '../streamwallState.tsx'

/**
 * Registers ControlUI's global keyboard shortcuts: the two-layer alt-key
 * audio-listen and blur toggles, the censor shortcuts, the focused-cell swap
 * (role-gated), and undo/redo on the shared views doc. Extracted from the
 * composition root so the shortcut wiring lives in one place (issue #393);
 * behavior — including the `enableOnFormTags` options and role gating — is
 * unchanged.
 */
export function useControlHotkeys({
  stateIdxMap,
  focusedInputIdx,
  role,
  handleSetListening,
  handleSetBlurred,
  setStreamCensored,
  handleSwapView,
  undoManager,
}: {
  stateIdxMap: Map<number, ViewInfo>
  focusedInputIdx: number | undefined
  role: StreamwallRole | null
  handleSetListening: (idx: number, listening: boolean) => void
  handleSetBlurred: (idx: number, blurred: boolean) => void
  setStreamCensored: (isCensored: boolean) => void
  handleSwapView: (idx: number) => void
  undoManager: Y.UndoManager | undefined
}) {
  const toggleListening = useCallback(
    (idx: number) => {
      const isListening = stateIdxMap.get(idx)?.isListening ?? false
      handleSetListening(idx, !isListening)
    },
    [stateIdxMap, handleSetListening],
  )
  // Audio-listen toggle, layer 0: alt+<key> -> cells 0-19. `enableOnFormTags`
  // keeps the hotkey live while a grid input is focused.
  useHotkeys(
    hotkeyLayerBindings[0],
    (ev, { hotkey }) => {
      ev.preventDefault()
      toggleListening(hotkeyTriggers.indexOf(hotkey[hotkey.length - 1]))
    },
    { enableOnFormTags: true },
    [toggleListening],
  )
  // Audio-listen toggle, layer 1: alt+ctrl+<key> -> cells 20-39 (see
  // `hotkeyLayers`). Same trigger keys, offset by one layer of 20 cells.
  useHotkeys(
    hotkeyLayerBindings[1],
    (ev, { hotkey }) => {
      ev.preventDefault()
      toggleListening(
        hotkeyTriggers.length +
          hotkeyTriggers.indexOf(hotkey[hotkey.length - 1]),
      )
    },
    { enableOnFormTags: true },
    [toggleListening],
  )
  const toggleBlurred = useCallback(
    (idx: number) => {
      const isBlurred = stateIdxMap.get(idx)?.isBlurred ?? false
      handleSetBlurred(idx, !isBlurred)
    },
    [stateIdxMap, handleSetBlurred],
  )
  // Blur toggle, layer 0: alt+shift+<key> -> cells 0-19.
  useHotkeys(
    blurHotkeyLayerBindings[0],
    (ev, { hotkey }) => {
      ev.preventDefault()
      toggleBlurred(hotkeyTriggers.indexOf(hotkey[hotkey.length - 1]))
    },
    [toggleBlurred],
  )
  // Blur toggle, layer 1: alt+ctrl+shift+<key> -> cells 20-39 (see
  // `blurHotkeyLayers`). Same trigger keys, offset by one layer of 20 cells.
  useHotkeys(
    blurHotkeyLayerBindings[1],
    (ev, { hotkey }) => {
      ev.preventDefault()
      toggleBlurred(
        hotkeyTriggers.length +
          hotkeyTriggers.indexOf(hotkey[hotkey.length - 1]),
      )
    },
    [toggleBlurred],
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
      if (focusedInputIdx != null && roleCan(role, 'mutate-state-doc')) {
        handleSwapView(focusedInputIdx)
      }
    },
    [handleSwapView, focusedInputIdx, role],
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
}
