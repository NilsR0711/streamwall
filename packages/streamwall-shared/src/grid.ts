/** Default number of columns and rows when no grid size is configured. */
export const DEFAULT_GRID_COUNT = 3

/**
 * Upper bound for a single grid dimension. Guards against absurd
 * configurations that would spawn thousands of views and exhaust resources.
 */
export const MAX_GRID_DIMENSION = 100

export interface GridDimensionsInput {
  /** Shorthand for a square grid: sets both cols and rows. */
  count?: number
  /** Explicit number of columns. Overrides `count`. */
  cols?: number
  /** Explicit number of rows. Overrides `count`. */
  rows?: number
}

export interface GridDimensions {
  cols: number
  rows: number
}

function validateDimension(name: 'cols' | 'rows', value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_GRID_DIMENSION) {
    throw new Error(
      `Invalid grid ${name}: ${value}. ` +
        `Must be an integer between 1 and ${MAX_GRID_DIMENSION}.`,
    )
  }
}

/**
 * Resolve the effective grid dimensions from configuration input.
 *
 * `count` provides a square grid; explicit `cols`/`rows` override it,
 * allowing non-square grids. Any dimension left unset falls back to
 * `count`, which itself defaults to {@link DEFAULT_GRID_COUNT}.
 *
 * @throws if a resolved dimension is not an integer in
 *   `[1, MAX_GRID_DIMENSION]`.
 */
export function resolveGridDimensions(
  input: GridDimensionsInput,
): GridDimensions {
  const count = input.count ?? DEFAULT_GRID_COUNT
  const cols = input.cols ?? count
  const rows = input.rows ?? count
  validateDimension('cols', cols)
  validateDimension('rows', rows)
  return { cols, rows }
}
