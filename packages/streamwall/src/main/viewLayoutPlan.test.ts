import { asCellIdx, type CellIdx, type ViewContent } from 'streamwall-shared'
import { describe, expect, it } from 'vitest'
import { planViewLayout, type ViewCandidate } from './viewLayoutPlan'

const streamA: ViewContent = { url: 'https://example.com/a', kind: 'video' }
const streamB: ViewContent = { url: 'https://example.com/b', kind: 'video' }
const streamC: ViewContent = { url: 'https://example.com/c', kind: 'video' }

function cells(...idxs: number[]): CellIdx[] {
  return idxs.map(asCellIdx)
}

function box(content: ViewContent | undefined, ...spaces: number[]) {
  return { content, spaces: cells(...spaces) }
}

/**
 * A named stand-in for an existing view actor. The planner treats `view` as an
 * opaque payload, so a plain string is enough to assert on.
 */
function candidate(
  name: string,
  opts: {
    content?: ViewContent | null
    spaces?: number[]
    running?: boolean
  } = {},
): ViewCandidate<string> {
  return {
    view: name,
    content: opts.content ?? null,
    spaces: opts.spaces === undefined ? undefined : cells(...opts.spaces),
    isRunning: opts.running ?? false,
  }
}

describe('planViewLayout', () => {
  it('leaves every box unmatched when there are no candidates', () => {
    const boxA = box(streamA, 0)
    const boxB = box(streamB, 1)

    const plan = planViewLayout([boxA, boxB], [])

    expect(plan.reused).toEqual([])
    expect(plan.unmatchedBoxes).toEqual([boxA, boxB])
    expect(plan.unusedViews).toEqual([])
  })

  it('returns every candidate as unused when there are no boxes', () => {
    const plan = planViewLayout(
      [],
      [candidate('a', { content: streamA, spaces: [0], running: true })],
    )

    expect(plan.reused).toEqual([])
    expect(plan.unmatchedBoxes).toEqual([])
    expect(plan.unusedViews).toEqual(['a'])
  })

  it('matches a running view showing the same content in the same space first', () => {
    const boxA = box(streamA, 0)

    const plan = planViewLayout(
      [boxA],
      [
        candidate('elsewhere', {
          content: streamA,
          spaces: [1],
          running: true,
        }),
        candidate('inPlace', { content: streamA, spaces: [0], running: true }),
      ],
    )

    expect(plan.reused).toEqual([{ box: boxA, view: 'inPlace' }])
    expect(plan.unusedViews).toEqual(['elsewhere'])
  })

  it('matches a running view showing the same content in a different space when none is in place', () => {
    const boxA = box(streamA, 0)

    const plan = planViewLayout(
      [boxA],
      [candidate('moved', { content: streamA, spaces: [5], running: true })],
    )

    expect(plan.reused).toEqual([{ box: boxA, view: 'moved' }])
    expect(plan.unusedViews).toEqual([])
  })

  it('matches a still-loading view with the same content when no running one exists', () => {
    const boxA = box(streamA, 0)

    const plan = planViewLayout(
      [boxA],
      [candidate('loading', { content: streamA, spaces: [0], running: false })],
    )

    expect(plan.reused).toEqual([{ box: boxA, view: 'loading' }])
  })

  it('falls back to the running view occupying the space across a genuine content change (issue #311)', () => {
    const boxB = box(streamB, 0)

    const plan = planViewLayout(
      [boxB],
      [candidate('there', { content: streamA, spaces: [0], running: true })],
    )

    expect(plan.reused).toEqual([{ box: boxB, view: 'there' }])
    expect(plan.unmatchedBoxes).toEqual([])
  })

  it('does not apply the space fallback to a non-running view, which has no DISPLAY handler for changed content', () => {
    const boxB = box(streamB, 0)

    const plan = planViewLayout(
      [boxB],
      [candidate('loading', { content: streamA, spaces: [0], running: false })],
    )

    expect(plan.reused).toEqual([])
    expect(plan.unmatchedBoxes).toEqual([boxB])
    expect(plan.unusedViews).toEqual(['loading'])
  })

  it('resolves an exact content match before any space-only fallback, across boxes', () => {
    // Mirrors the three-box scenario in StreamWindow.test.ts: the exact
    // content matcher must claim `moved` for box 2 before the space fallback
    // could steal it for box 1.
    const boxAtZero = box(streamC, 0)
    const boxAtOne = box(streamA, 1)
    const boxAtTwo = box(streamB, 2)

    const plan = planViewLayout(
      [boxAtZero, boxAtOne, boxAtTwo],
      [
        candidate('spaceOnly', {
          content: streamC,
          spaces: [0],
          running: true,
        }),
        candidate('moved', { content: streamB, spaces: [1], running: true }),
      ],
    )

    expect(plan.reused).toEqual([
      { box: boxAtZero, view: 'spaceOnly' },
      { box: boxAtTwo, view: 'moved' },
    ])
    expect(plan.unmatchedBoxes).toEqual([boxAtOne])
    expect(plan.unusedViews).toEqual([])
  })

  it('never assigns one candidate to two boxes', () => {
    const boxOne = box(streamA, 0)
    const boxTwo = box(streamA, 1)

    const plan = planViewLayout(
      [boxOne, boxTwo],
      [candidate('only', { content: streamA, spaces: [0], running: true })],
    )

    expect(plan.reused).toEqual([{ box: boxOne, view: 'only' }])
    expect(plan.unmatchedBoxes).toEqual([boxTwo])
  })

  it('breaks ties in candidate order, so live views win over parked ones', () => {
    const boxA = box(streamA, 0)

    const plan = planViewLayout(
      [boxA],
      [
        candidate('live', { content: streamA, spaces: [0], running: true }),
        candidate('parked', { content: streamA, spaces: [0], running: true }),
      ],
    )

    expect(plan.reused).toEqual([{ box: boxA, view: 'live' }])
    expect(plan.unusedViews).toEqual(['parked'])
  })

  it('matches a view with no placement yet by content alone', () => {
    const boxA = box(streamA, 0)

    const plan = planViewLayout(
      [boxA],
      [candidate('unplaced', { content: streamA, running: true })],
    )

    expect(plan.reused).toEqual([{ box: boxA, view: 'unplaced' }])
  })

  it('matches a box spanning several cells against a view overlapping any of them', () => {
    const wide = box(streamA, 0, 1, 2, 3)

    const plan = planViewLayout(
      [wide],
      [candidate('corner', { content: streamA, spaces: [3], running: true })],
    )

    expect(plan.reused).toEqual([{ box: wide, view: 'corner' }])
  })
})
