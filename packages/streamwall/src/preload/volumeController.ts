export function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, volume))
}

// Applies a 0-1 volume level to an acquired media element, mirroring how
// RotationController owns the currently-acquired element's CSS rotation.
export class VolumeController {
  media: HTMLMediaElement

  constructor(media: HTMLMediaElement, initialVolume = 1) {
    this.media = media
    this.setVolume(initialVolume)
  }

  setVolume(volume: number) {
    this.media.volume = clampVolume(volume)
  }
}
