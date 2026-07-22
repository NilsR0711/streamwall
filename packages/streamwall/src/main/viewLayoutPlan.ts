import { intersection, isEqual } from 'lodash-es'
import type { CellIdx, ViewContent } from 'streamwall-shared'

/**
 * The subset of a box produced by `boxesFromViewContentMap` that the planner
 * needs. Kept structural so the caller can pass the full box through
 * untouched and get the very same object back in the plan.
 */
export interface PlannableBox {
  content: ViewContent | undefined
  spaces: CellIdx[]
}

/**
 * What the planner is allowed to know about an existing view actor: the two
 * things the matchers read from its snapshot, plus the actor itself as an
 * opaque payload.
 *
 * Note the addressing axes stay separate here (issue #397/#507): `spaces`
 * holds *cell indexes* (positions in the current grid), never the actor's
 * stable view id. The planner never looks at the view id at all -- reuse is
 * decided purely from content and occupied cells, and the caller keys the
 * resulting actors by their own `context.id` afterwards.
 */
export interface ViewCandidate<TView> {
  view: TView
  /** The content the actor is currently showing, if any. */
  content: ViewContent | null | undefined
  /** The grid cells the actor currently occupies, if it has a placement. */
  spaces: CellIdx[] | undefined
  /** Whether the actor is in `displaying.running`. */
  isRunning: boolean
}

export interface ViewLayoutPlan<TBox, TView> {
  /** Boxes matched to an existing actor, in the order they were matched. */
  reused: Array<{ box: TBox; view: TView }>
  /** Boxes no existing actor could serve; the caller must create views for these. */
  unmatchedBoxes: TBox[]
  /** Actors no box claimed; the caller parks or tears these down. */
  unusedViews: TView[]
}

type Matcher<TView> = (
  candidate: ViewCandidate<TView>,
  content: ViewContent | undefined,
  spaces: CellIdx[] | undefined,
) => boolean

/**
 * We try to find the best match for moving / reusing existing views to match
 * the new positions. Applied in order: every remaining box gets a chance at
 * matcher *n* before matcher *n+1* is considered at all.
 */
const matchers: Array<Matcher<unknown>> = [
  // First try to find a loaded view of the same URL in the same space...
  ({ content: viewContent, spaces: viewSpaces, isRunning }, content, spaces) =>
    isEqual(viewContent, content) &&
    isRunning &&
    intersection(viewSpaces, spaces).length > 0,
  // Then try to find a loaded view of the same URL...
  ({ content: viewContent, isRunning }, content) =>
    isEqual(viewContent, content) && isRunning,
  // Then try view with the same URL that is still loading...
  ({ content: viewContent }, content) => isEqual(viewContent, content),
  // Finally, if no view already shows this content, reuse whichever
  // running view already occupies the box's space regardless of its
  // content, so a genuine content change (a playlist advance, a
  // drag-to-place reassignment) reuses the actor already there via a
  // DISPLAY event -- letting `running`'s own swap handling take over --
  // instead of always tearing it down and creating a brand-new one.
  // Scoped to `running` only: `loading`/`error` have no DISPLAY handler
  // of their own for changed content, so the event would bubble up to
  // `displaying`'s handler, whose `contentUnchanged` guard would then
  // silently drop it and strand the actor on its old content.
  ({ spaces: viewSpaces, isRunning }, _content, spaces) =>
    isRunning && intersection(viewSpaces, spaces).length > 0,
]

/**
 * Decides, for a requested wall layout, which existing view actors get reused
 * for which boxes, which boxes need a brand-new view, and which actors are
 * left over.
 *
 * Pure: it performs no side effects and does not touch the actors it is given
 * (they are opaque payloads). `StreamWindow.setViews` is the executor of the
 * plan this returns.
 *
 * `candidates` order is significant: when several actors match a box equally
 * well, the earliest one wins. `StreamWindow` passes its live views before its
 * parked ones, so a live view is preferred over a parked one (issue #369).
 *
 * Caller assumption: the `candidates` list must not contain the same actor
 * twice. The pool below is consumed by *candidate object* identity, not by
 * actor identity, so a duplicated actor wrapped in two candidate objects would
 * be handed to two different boxes and then be positioned twice by
 * `StreamWindow.setViews`. This is unreachable today because `views` and
 * `parkedViews` -- the only two sources `reuseCandidates()` concatenates -- are
 * disjoint by construction (`setViews` clears `parkedViews` and rebuilds it
 * only from actors no box claimed). Anything that adds a third source, or lets
 * an actor live in both maps at once, must deduplicate by actor identity here.
 */
export function planViewLayout<TBox extends PlannableBox, TView>(
  boxes: TBox[],
  candidates: Array<ViewCandidate<TView>>,
): ViewLayoutPlan<TBox, TView> {
  const remainingBoxes = new Set(boxes)
  const unusedViews = new Set(candidates)
  const reused: Array<{ box: TBox; view: TView }> = []

  for (const matcher of matchers as Array<Matcher<TView>>) {
    for (const box of remainingBoxes) {
      const { content, spaces } = box
      let found: ViewCandidate<TView> | undefined
      for (const candidate of unusedViews) {
        if (matcher(candidate, content, spaces)) {
          found = candidate
          break
        }
      }
      if (found) {
        reused.push({ box, view: found.view })
        unusedViews.delete(found)
        remainingBoxes.delete(box)
      }
    }
  }

  return {
    reused,
    unmatchedBoxes: [...remainingBoxes],
    unusedViews: [...unusedViews].map(({ view }) => view),
  }
}
