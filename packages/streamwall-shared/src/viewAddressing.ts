/**
 * The wall has two numeric addressing axes that are structurally identical but
 * mean completely different things:
 *
 * - a **view id** names one running view actor for the whole lifetime of that
 *   actor (its creation-time `webContents.id`), and survives grid resizes and
 *   remaps (issue #397/#467);
 * - a **cell index** names a position in the *current* grid, and shifts
 *   whenever the layout changes.
 *
 * Passing one where the other was expected used to type-check — that is how
 * issue #470 slipped through. Branding both axes makes the compiler reject the
 * mix-up while leaving them plain numbers at runtime (issue #507).
 *
 * This module deliberately has no imports so both `schemas.ts` and
 * `geometry.ts` can depend on it without creating a cycle.
 */

declare const viewAddressingBrand: unique symbol

/** A stable per-view identity. See the module comment. */
export type ViewId = number & { readonly [viewAddressingBrand]: 'ViewId' }

/** A grid cell index. See the module comment. */
export type CellIdx = number & { readonly [viewAddressingBrand]: 'CellIdx' }

/**
 * Tags a raw number as a {@link ViewId} without validating it. Use only where
 * the value provably *is* a view identity — an actor's `webContents.id`, the
 * output of a schema that already validated it, or a test fixture. Untrusted
 * input belongs in `viewIdSchema` instead.
 */
export function asViewId(value: number): ViewId {
  return value as ViewId
}

/** The {@link CellIdx} counterpart of {@link asViewId}. */
export function asCellIdx(value: number): CellIdx {
  return value as CellIdx
}
