// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import {
  installVisibilityOverride,
  overrideVisibility,
  VISIBILITY_OVERRIDE_SCRIPT,
} from './visibilityOverride'

describe('installVisibilityOverride', () => {
  it('runs the visibility override script in the main world via webFrame.executeJavaScript', () => {
    const executeJavaScript = vi.fn()

    installVisibilityOverride({ executeJavaScript })

    expect(executeJavaScript).toHaveBeenCalledTimes(1)
    expect(executeJavaScript).toHaveBeenCalledWith(VISIBILITY_OVERRIDE_SCRIPT)
  })
})

describe('overrideVisibility', () => {
  function makeHidden() {
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    })
    Object.defineProperty(document, 'hidden', {
      value: true,
      writable: true,
      configurable: true,
    })
  }

  it('spoofs document.visibilityState and hidden as visible', () => {
    makeHidden()

    overrideVisibility()

    expect(document.visibilityState).toBe('visible')
    expect(document.hidden).toBe(false)
  })

  it('dispatches a visibilitychange event so page listeners re-check visibility', () => {
    makeHidden()
    const dispatchSpy = vi.spyOn(document, 'dispatchEvent')

    overrideVisibility()

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'visibilitychange' }),
    )
  })
})

describe('VISIBILITY_OVERRIDE_SCRIPT', () => {
  it('is an immediately-invoked serialization of overrideVisibility', () => {
    expect(VISIBILITY_OVERRIDE_SCRIPT).toBe(`(${overrideVisibility})()`)
  })
})
