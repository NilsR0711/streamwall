import { viewStateValueSchema } from 'streamwall-shared'
import { describe, expect, it, vi } from 'vitest'

// viewStateMachine imports electron (directly and via ./loadHTML). Only the
// machine's static state tree is inspected here, so bare stubs are enough.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  WebContents: class {},
}))

const { default: viewStateMachine } = await import('./viewStateMachine')

type StateNodeLike = {
  key: string
  type: string
  states: Record<string, StateNodeLike>
}

type StateValue = string | { [key: string]: StateValue }

/**
 * Every state value this node can report for its own subtree, i.e. what XState
 * puts under the node's key in a snapshot `.value`. Atomic (and final) nodes
 * have no subtree and therefore contribute nothing; their parent represents
 * them by their bare key.
 */
function subtreeValues(node: StateNodeLike): StateValue[] {
  const children = Object.values(node.states ?? {})
  if (children.length === 0) {
    return []
  }
  if (node.type === 'parallel') {
    // All regions are active simultaneously, so the node's value is the
    // cartesian product of its regions' values.
    return children.reduce<StateValue[]>(
      (combinations, region) =>
        combinations.flatMap((combination) =>
          childValues(region).map((value) => ({
            ...(combination as object),
            ...(value as object),
          })),
        ),
      [{}],
    )
  }
  // Compound node: exactly one child is active at a time.
  return children.flatMap(childValues)
}

/** How a parent represents `node` inside its own state value. */
function childValues(node: StateNodeLike): StateValue[] {
  const nested = subtreeValues(node)
  if (nested.length === 0) {
    if (node.type === 'parallel') {
      throw new Error(`Parallel state '${node.key}' has no regions`)
    }
    return [node.key]
  }
  return nested.map((value) => ({ [node.key]: value }))
}

const allStateValues = subtreeValues(
  viewStateMachine.root as unknown as StateNodeLike,
)

/**
 * `streamwall-shared`'s `viewStateValueSchema` is a hand-written mirror of this
 * machine's snapshot shape, and the control server validates every uplink state
 * message against it (issue #387/#419). The two live in different packages with
 * no compile-time link, so this exhaustively enumerates the machine's reachable
 * state values and fails here — in CI — instead of silently degrading the
 * control server's view of the wall once the machine grows a state.
 */
describe('view state value schema drift', () => {
  it('enumerates the machine tree', () => {
    // Sanity check on the enumeration itself: a bug that yields an empty (or
    // trivially small) list would make every assertion below vacuous.
    expect(allStateValues).toContain('empty')
    expect(allStateValues).toContainEqual({ displaying: 'error' })
    expect(allStateValues.length).toBeGreaterThan(10)
  })

  it.each(allStateValues.map((value) => [JSON.stringify(value), value]))(
    'accepts %s without dropping data',
    (_label, value) => {
      const result = viewStateValueSchema.safeParse(value)
      expect(result.error?.issues[0]?.message).toBeUndefined()
      expect(result.success).toBe(true)
      // Zod strips unknown keys rather than rejecting them, so a parse that
      // "succeeds" can still silently discard a whole parallel region.
      expect(result.data).toEqual(value)
    },
  )
})
