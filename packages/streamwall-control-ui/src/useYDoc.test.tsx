import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { useYDoc } from './useYDoc.ts'

const { docConstructorSpy } = vi.hoisted(() => ({
  docConstructorSpy: vi.fn(),
}))

vi.mock('yjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yjs')>()
  function Doc(...args: ConstructorParameters<typeof actual.Doc>) {
    docConstructorSpy()
    return new actual.Doc(...args)
  }
  Doc.prototype = actual.Doc.prototype
  return { ...actual, Doc }
})

let container: HTMLDivElement | undefined

afterEach(() => {
  docConstructorSpy.mockClear()
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderUseYDoc(): {
  get: () => ReturnType<typeof useYDoc<{ views: unknown }>>
  rerender: () => void
} {
  let latest: ReturnType<typeof useYDoc<{ views: unknown }>> | undefined
  function Harness() {
    latest = useYDoc<{ views: unknown }>(['views'])
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<Harness />, container!)
  })
  return {
    get: () => latest!,
    rerender: () => {
      act(() => {
        render(<Harness />, container!)
      })
    },
  }
}

describe('useYDoc', () => {
  it('creates exactly one Y.Doc across re-renders', () => {
    const harness = renderUseYDoc()
    expect(docConstructorSpy).toHaveBeenCalledTimes(1)
    const firstDoc = harness.get().doc

    harness.rerender()
    harness.rerender()

    expect(docConstructorSpy).toHaveBeenCalledTimes(1)
    expect(harness.get().doc).toBe(firstDoc)
  })

  it('destroys the previous doc when setDoc replaces it', () => {
    const harness = renderUseYDoc()
    const firstDoc = harness.get().doc
    const destroySpy = vi.spyOn(firstDoc, 'destroy')

    const replacementDoc = new Y.Doc()
    act(() => {
      harness.get().setDoc(replacementDoc)
    })

    expect(destroySpy).toHaveBeenCalledTimes(1)
    expect(harness.get().doc).toBe(replacementDoc)
  })
})
