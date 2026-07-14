import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { GridControls } from './index.tsx'

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
        idx={0}
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

  test('sends the new volume for this tile when the slider changes', () => {
    const onSetVolume = vi.fn()
    const box = renderControls({ idx: 3, volume: 1, onSetVolume })
    const slider = box.querySelector('input[type="range"]') as HTMLInputElement

    act(() => {
      slider.value = '0.3'
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onSetVolume).toHaveBeenCalledWith(3, 0.3)
  })
})
