// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import { TailSpin } from './TailSpin'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

describe('TailSpin', () => {
  test('uses a per-instance gradient id so multiple simultaneous spinners stay valid SVG', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <div>
          <TailSpin />
          <TailSpin />
        </div>,
        container!,
      )
    })

    const svgs = container.querySelectorAll('svg')
    expect(svgs).toHaveLength(2)

    const gradientIds = Array.from(svgs).map(
      (svg) => svg.querySelector('linearGradient')!.id,
    )

    // Per the SVG/HTML spec, `id` must be document-unique; duplicate ids
    // mean `url(#...)` references can resolve to the wrong element (#212).
    expect(new Set(gradientIds).size).toBe(gradientIds.length)
    for (const id of gradientIds) {
      expect(id).not.toBe('')
    }

    // Each path's stroke must reference its own tile's gradient, not just
    // any gradient with a matching (possibly duplicated) id.
    svgs.forEach((svg) => {
      const gradientId = svg.querySelector('linearGradient')!.id
      const path = svg.querySelector('path')!
      expect(path.getAttribute('stroke')).toBe(`url(#${gradientId})`)
    })
  })
})
