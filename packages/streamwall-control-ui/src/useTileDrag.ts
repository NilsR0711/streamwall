import { useCallback, useLayoutEffect, useState } from 'preact/hooks'
import { useHotkeys } from 'react-hotkeys-hook'
import { type CellIdx, roleCan, type StreamwallRole } from 'streamwall-shared'
import * as Y from 'yjs'
import {
  computeHoveringIdx,
  isPrimaryButton,
  resolveMoveTarget,
} from './gestures'
import { computeSwap, type SwapBox } from './gridInteractions'

interface TileInfo {
  spaces: CellIdx[]
}

/**
 * Manages the grid wall's swap-click and drag-move gestures: which cell is
 * hovered, which cell (if any) started a swap or a drag-move, and committing
 * the resulting stream-id swap into the shared Yjs `views` map. Shared with
 * `useTileResize` only via `hoveringIdx`, which both gestures need to know
 * which cell the pointer is currently over.
 */
export function useTileDrag({
  cols,
  rows,
  stateDoc,
  stateIdxMap,
  role,
}: {
  cols: number | null | undefined
  rows: number | null | undefined
  stateDoc: Y.Doc
  stateIdxMap: Map<CellIdx, TileInfo>
  role: StreamwallRole | null
}) {
  const [swapStartIdx, setSwapStartIdx] = useState<CellIdx | undefined>()
  const handleSwapView = useCallback(
    (idx: CellIdx) => {
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
  // Used by both the swap gesture (`handleSwap`) and the drag-move gesture
  // (`endMove` below) to commit a two-box exchange.
  //
  // Known limitation: this reads each box's current streamId and writes both
  // boxes' new streamIds as independent keys in the shared Yjs map. Yjs
  // resolves concurrent edits per key (last-writer-wins), not across the pair
  // atomically. If two operators swap/move overlapping boxes at nearly the
  // same time, each computes its reassignment from a state the other is also
  // about to overwrite — the merged result can duplicate one stream into both
  // boxes while dropping the other. This is inherent to modeling the grid as
  // independent per-cell keys rather than a single atomically-swapped value;
  // a real fix would need a server-side or CRDT-level guard (e.g. rejecting a
  // swap whose read boxes changed since it started). Low impact in practice
  // since concurrent operators rarely target the same cells simultaneously.
  const swapBoxes = useCallback(
    (fromIdx: CellIdx, toIdx: CellIdx) => {
      if (cols == null || rows == null || !roleCan(role, 'mutate-state-doc')) {
        return
      }
      stateDoc.transact(() => {
        const viewsMap = stateDoc.getMap<Y.Map<string | undefined>>('views')
        const boxes = new Map<CellIdx, SwapBox>()
        for (const idx of [fromIdx, toIdx]) {
          const viewInfo = stateIdxMap.get(idx)
          if (viewInfo === undefined) {
            // No box occupies this index — leave it out of `boxes` so
            // `computeSwap` treats it as a genuinely empty target rather
            // than a single-space box, letting it translate a merged
            // source box's whole footprint there instead of collapsing it.
            continue
          }
          boxes.set(idx, {
            spaces: viewInfo.spaces,
            streamId: viewsMap.get(String(idx))?.get('streamId'),
          })
        }
        const assignments = computeSwap(boxes, fromIdx, toIdx, cols, rows)
        for (const [idx, streamId] of assignments) {
          viewsMap.get(String(idx))?.set('streamId', streamId)
        }
      })
    },
    [stateDoc, stateIdxMap, cols, rows, role],
  )

  const handleSwap = useCallback(
    (toIdx: CellIdx) => {
      if (swapStartIdx === undefined) {
        return
      }
      swapBoxes(swapStartIdx, toIdx)
      setSwapStartIdx(undefined)
    },
    [swapBoxes, swapStartIdx],
  )

  const [hoveringIdx, setHoveringIdx] = useState<CellIdx>()
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
    { idx: CellIdx; x: number; y: number } | undefined
  >()
  const [moveTargetIdx, setMoveTargetIdx] = useState<CellIdx | undefined>()

  const handleGridPointerDown = useCallback(
    (ev: PointerEvent) => {
      if (
        !isPrimaryButton(ev.button) ||
        hoveringIdx == null ||
        !roleCan(role, 'mutate-state-doc')
      ) {
        return
      }
      if (swapStartIdx !== undefined) {
        handleSwap(hoveringIdx)
        return
      }
      setMoveStart({ idx: hoveringIdx, x: ev.clientX, y: ev.clientY })
    },
    [hoveringIdx, swapStartIdx, handleSwap, role],
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

  // Escape cancels an in-progress drag-move without committing. The window
  // pointerup/pointercancel listener above is a no-op once moveStart is
  // cleared.
  useHotkeys(
    `escape`,
    () => {
      setMoveStart(undefined)
    },
    // Also fire while a grid input is focused during a gesture.
    { enableOnFormTags: true },
    [setMoveStart],
  )

  return {
    hoveringIdx,
    swapStartIdx,
    moveStart,
    moveTargetIdx,
    updateHoveringIdx,
    clearHoveringIdx,
    handleSwapView,
    handleGridPointerDown,
  }
}
