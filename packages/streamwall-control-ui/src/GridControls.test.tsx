import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { GridControls } from './GridControls.tsx'
import { asCellIdx, asViewId } from './viewAddressing.ts'

// react-icons renders through preact/compat's Context.Consumer, which
// currently crashes under this package's happy-dom test environment
// (unrelated to the controls under test here) - stub the icons out so the
// component can render.
vi.mock('react-icons/fa', () => ({
  FaExchangeAlt: () => null,
  FaRedoAlt: () => null,
  FaRegLifeRing: () => null,
  FaRegWindowMaximize: () => null,
  FaSyncAlt: () => null,
  FaVideoSlash: () => null,
  FaVolumeUp: () => null,
}))

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderControls(
  props: Partial<Parameters<typeof GridControls>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <GridControls
        idx={asCellIdx(0)}
        viewId={asViewId(0)}
        streamId="abc"
        style={{}}
        isDisplaying={true}
        isListening={false}
        isBackgroundListening={false}
        isBlurred={false}
        isSwapping={false}
        showDebug={false}
        role="operator"
        volume={1}
        onSetListening={() => {}}
        onSetBackgroundListening={() => {}}
        onSetBlurred={() => {}}
        onSetVolume={() => {}}
        onReloadView={() => {}}
        onSwapView={() => {}}
        onRotateView={() => {}}
        onBrowse={() => {}}
        onDevTools={() => {}}
        onPointerDown={() => {}}
        onToggleFullscreen={() => {}}
        {...props}
      />,
      container!,
    )
  })
  return container
}

describe('GridControls volume slider', () => {
  test('renders a volume slider reflecting the current volume for an operator', () => {
    const box = renderControls({ volume: 0.4 })

    const slider = box.querySelector('input[type="range"]')
    expect(slider).not.toBeNull()
    expect((slider as HTMLInputElement).value).toBe('0.4')
  })

  test('does not render a volume slider for a monitor role', () => {
    const box = renderControls({ role: 'monitor' })

    expect(box.querySelector('input[type="range"]')).toBeNull()
  })

  test('sends the new volume addressed by this tile view id when the slider changes', () => {
    const onSetVolume = vi.fn()
    // viewId deliberately differs from idx to prove the command carries the
    // stable view id, not the grid cell index (issue #397).
    const box = renderControls({
      idx: asCellIdx(0),
      viewId: asViewId(3),
      volume: 1,
      onSetVolume,
    })
    const slider = box.querySelector('input[type="range"]') as HTMLInputElement

    act(() => {
      slider.value = '0.3'
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onSetVolume).toHaveBeenCalledWith(3, 0.3)
  })
})

describe('GridControls double-click to toggle fullscreen', () => {
  test('toggles fullscreen for this tile when its open area is double-clicked', () => {
    const onToggleFullscreen = vi.fn()
    const box = renderControls({
      idx: asCellIdx(0),
      viewId: asViewId(4),
      onToggleFullscreen,
    })
    const controls = box.firstElementChild as HTMLElement

    act(() => {
      controls.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    expect(onToggleFullscreen).toHaveBeenCalledWith(4)
  })

  test('ignores double-clicks that land on a control button', () => {
    const onToggleFullscreen = vi.fn()
    const box = renderControls({ onToggleFullscreen })
    const button = box.querySelector('button') as HTMLButtonElement

    act(() => {
      button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    expect(onToggleFullscreen).not.toHaveBeenCalled()
  })

  test('does not toggle fullscreen for a monitor role', () => {
    const onToggleFullscreen = vi.fn()
    const box = renderControls({ role: 'monitor', onToggleFullscreen })
    const controls = box.firstElementChild as HTMLElement

    act(() => {
      controls.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    expect(onToggleFullscreen).not.toHaveBeenCalled()
  })
})

describe('GridControls accessible names', () => {
  test('gives every icon-only button a descriptive aria-label', () => {
    const box = renderControls({ role: 'admin', showDebug: true })

    expect(
      box.querySelector('button[aria-label="Reload stream"]'),
    ).not.toBeNull()
    expect(
      box.querySelector('button[aria-label="Open stream in browser"]'),
    ).not.toBeNull()
    expect(
      box.querySelector('button[aria-label="Open developer tools"]'),
    ).not.toBeNull()
  })

  test('labels the swap and rotate buttons outside debug mode', () => {
    const box = renderControls({ showDebug: false })

    expect(box.querySelector('button[aria-label="Swap stream"]')).not.toBeNull()
    expect(
      box.querySelector('button[aria-label="Rotate stream"]'),
    ).not.toBeNull()
  })

  test('flips the swap button label to "Cancel swap" while swapping', () => {
    const box = renderControls({ isSwapping: true })

    expect(box.querySelector('button[aria-label="Cancel swap"]')).not.toBeNull()
    expect(box.querySelector('button[aria-label="Swap stream"]')).toBeNull()
  })

  test('labels the blur toggle button by its current state', () => {
    let box = renderControls({ isBlurred: false })
    expect(box.querySelector('button[aria-label="Blur video"]')).not.toBeNull()

    box = renderControls({ isBlurred: true })
    expect(
      box.querySelector('button[aria-label="Unblur video"]'),
    ).not.toBeNull()
  })

  test('labels the listening toggle button by its current state', () => {
    let box = renderControls({
      isListening: false,
      isBackgroundListening: false,
    })
    expect(
      box.querySelector('button[aria-label="Listen to audio"]'),
    ).not.toBeNull()

    box = renderControls({ isListening: true })
    expect(box.querySelector('button[aria-label="Mute audio"]')).not.toBeNull()

    box = renderControls({ isBackgroundListening: true })
    expect(box.querySelector('button[aria-label="Mute audio"]')).not.toBeNull()
  })

  test('does not set a positive tabIndex on any button, relying on native DOM order', () => {
    const box = renderControls({ isBlurred: true })

    for (const button of Array.from(box.querySelectorAll('button'))) {
      expect(button.getAttribute('tabindex')).not.toBe('1')
    }
  })
})
