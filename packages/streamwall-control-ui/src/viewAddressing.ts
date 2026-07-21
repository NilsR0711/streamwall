/**
 * The two numeric addressing axes of the wall, kept apart by the type system.
 *
 * A **view id** identifies a live view actor (`context.id`, i.e. the Electron
 * `webContents.id`) and is what every `set-view-*`/`reload-view`/`dev-tools`
 * control command addresses. A **cell index** identifies a position in the
 * grid (`cols * y + x`) and is what the shared Yjs `views` map, drag/swap
 * gestures, layout presets and `fullscreenViewIdx` are keyed by. The split was
 * introduced in #397/#467.
 *
 * Both are plain `number`s at runtime, so the compiler used to accept one
 * wherever the other was expected — that is exactly how #470 (a cell index
 * passed to a view-id command) slipped through review. Branding them makes the
 * mix-up a type error while keeping them assignable *to* `number`, so the pure
 * grid geometry helpers (`gestures.ts`, `gridInteractions.ts`,
 * `viewPlacement.ts`) can stay on plain numbers and only the boundaries where a
 * raw number enters the addressed surface need an explicit conversion.
 */

declare const viewIdBrand: unique symbol
declare const cellIdxBrand: unique symbol

/** A stable view actor id (`ViewState['context']['id']`). */
export type ViewId = number & { readonly [viewIdBrand]: true }

/** A grid cell index (`cols * y + x`). */
export type CellIdx = number & { readonly [cellIdxBrand]: true }

/**
 * Tag a raw number coming from the wire (view state, control responses) as a
 * view id. Purely a compile-time assertion — there is no runtime validation to
 * do, since any number the main process reports as `context.id` is one.
 */
export function asViewId(value: number): ViewId {
  return value as ViewId
}

/** Tag a raw number produced by grid geometry as a cell index. */
export function asCellIdx(value: number): CellIdx {
  return value as CellIdx
}

/** {@link asCellIdx} for a whole list, e.g. a view's occupied `spaces`. */
export function asCellIdxs(values: readonly number[]): CellIdx[] {
  return values.map(asCellIdx)
}
