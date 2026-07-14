import { describe, expect, it } from 'vitest'
import { clampVolume, VolumeController } from './volumeController'

describe('clampVolume', () => {
  it('passes through values already in range', () => {
    expect(clampVolume(0)).toBe(0)
    expect(clampVolume(0.5)).toBe(0.5)
    expect(clampVolume(1)).toBe(1)
  })

  it('clamps values below 0 up to 0', () => {
    expect(clampVolume(-0.5)).toBe(0)
  })

  it('clamps values above 1 down to 1', () => {
    expect(clampVolume(1.5)).toBe(1)
  })
})

describe('VolumeController', () => {
  function makeMedia(): HTMLMediaElement {
    return { volume: 1 } as HTMLMediaElement
  }

  it('applies the initial volume to the media element on construction', () => {
    const media = makeMedia()
    new VolumeController(media, 0.3)

    expect(media.volume).toBe(0.3)
  })

  it('defaults the initial volume to 1 when omitted', () => {
    const media = makeMedia()
    new VolumeController(media)

    expect(media.volume).toBe(1)
  })

  it('updates the media element volume on setVolume', () => {
    const media = makeMedia()
    const controller = new VolumeController(media, 1)

    controller.setVolume(0.2)

    expect(media.volume).toBe(0.2)
  })

  it('clamps out-of-range volumes applied via setVolume', () => {
    const media = makeMedia()
    const controller = new VolumeController(media)

    controller.setVolume(2)
    expect(media.volume).toBe(1)

    controller.setVolume(-1)
    expect(media.volume).toBe(0)
  })
})
