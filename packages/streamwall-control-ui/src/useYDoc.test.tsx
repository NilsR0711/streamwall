import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { z } from 'zod'
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

const viewsSchema = z.object({
  views: z.record(z.string(), z.object({ streamId: z.string().optional() })),
})
type ViewsDoc = z.infer<typeof viewsSchema>

function renderUseYDoc(schema: z.ZodType<ViewsDoc> = viewsSchema): {
  get: () => ReturnType<typeof useYDoc<ViewsDoc>>
  rerender: () => void
} {
  let latest: ReturnType<typeof useYDoc<ViewsDoc>> | undefined
  function Harness() {
    latest = useYDoc<ViewsDoc>(['views'], schema)
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

  it('sets docValue to the validated snapshot after a valid update', () => {
    const harness = renderUseYDoc()

    act(() => {
      harness.get().doc.getMap('views').set('0', { streamId: 'abc' })
    })

    expect(harness.get().docValue).toEqual({
      views: { '0': { streamId: 'abc' } },
    })
  })

  it('rejects an update that fails schema validation, logs a warning, and keeps the last known-good value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = renderUseYDoc()
    expect(harness.get().docValue).toEqual({ views: {} })

    act(() => {
      // `streamId` must be a string per `viewsSchema`.
      harness.get().doc.getMap('views').set('0', { streamId: 42 })
    })

    expect(harness.get().docValue).toEqual({ views: {} })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('keeps a non-empty known-good value when a later update fails validation', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = renderUseYDoc()

    act(() => {
      harness.get().doc.getMap('views').set('0', { streamId: 'abc' })
    })
    expect(harness.get().docValue).toEqual({
      views: { '0': { streamId: 'abc' } },
    })

    act(() => {
      harness.get().doc.getMap('views').set('1', { streamId: 42 })
    })

    expect(harness.get().docValue).toEqual({
      views: { '0': { streamId: 'abc' } },
    })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
