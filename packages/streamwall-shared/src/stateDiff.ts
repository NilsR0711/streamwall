import type { Delta } from 'jsondiffpatch'
import * as jsondiffpatch from 'jsondiffpatch'
import { z } from 'zod'

export const stateDiff = jsondiffpatch.create({
  objectHash: (obj, idx) => (obj as { _id?: string })._id || `$$index:${idx}`,
  omitRemovedValues: true,
})

/**
 * Deepest delta nesting accepted. The state tree is only a handful of levels
 * deep, so anything beyond this is malformed - and bounding the recursion
 * keeps a hostile payload from blowing the stack while it is validated.
 */
const MAX_DELTA_DEPTH = 20

/**
 * A delta value that is an array is a leaf operation. jsondiffpatch encodes
 * these as `[newValue]` (added), `[oldValue, newValue]` (modified),
 * `[oldValue, 0, 0]` (deleted) and `['', destIndex, 3]` (moved).
 *
 * Text diffs (`[oldText, 0, 2]`) are rejected: `stateDiff` is created without
 * a diff-match-patch instance, so it never emits them and `patch` would throw
 * on one anyway.
 */
function isDeltaOp(op: unknown[]): boolean {
  switch (op.length) {
    case 1:
    case 2:
      return true
    case 3:
      return (
        (op[1] === 0 && op[2] === 0) ||
        (op[0] === '' && typeof op[1] === 'number' && op[2] === 3)
      )
    default:
      return false
  }
}

function isDeltaNode(node: unknown, depth: number): boolean {
  if (Array.isArray(node)) {
    return isDeltaOp(node)
  }
  if (typeof node !== 'object' || node === null) {
    return false
  }
  if (depth >= MAX_DELTA_DEPTH) {
    return false
  }
  return Object.entries(node).every(([key, child]) =>
    // `_t: 'a'` marks an object delta as describing an array; every other key
    // carries a nested delta or a leaf operation.
    key === '_t' ? child === 'a' : isDeltaNode(child, depth + 1),
  )
}

/**
 * Validates a jsondiffpatch delta that came off the wire *before* it is
 * handed to `stateDiff.patch`.
 *
 * Patching untrusted input is not merely error-prone, it is unbounded: a
 * string where a nested delta belongs makes jsondiffpatch enumerate the
 * string as an index collection, allocating until the heap is exhausted. That
 * happens inside `patch`, so `try`/`catch` around it cannot contain it and a
 * single crafted `state-delta` frame can freeze an operator's browser tab
 * (issue #539). The shape has to be checked first.
 */
export const stateDeltaSchema = z.custom<Delta>(
  (value) => !Array.isArray(value) && isDeltaNode(value, 0),
  { message: 'Invalid state delta' },
)
