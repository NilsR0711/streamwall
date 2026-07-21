import type { ForgeConfig } from '@electron-forge/shared-types'
import { describe, expect, it, vi } from 'vitest'

const runTypecheck = vi.fn()
vi.mock('./forge.typecheck', () => ({ runTypecheck: () => runTypecheck() }))

const removePackagingTmpdir = vi.fn()
vi.mock('./forge.tmpdir', () => ({
  createPackagingTmpdir: () => '/tmp/streamwall-packager-test',
  removePackagingTmpdir: (dir: string) => removePackagingTmpdir(dir),
}))

const { default: config }: { default: ForgeConfig } =
  await import('./forge.config')

// `package`, `make` and `publish` all funnel through forge's package step, so
// a single `prePackage` hook covers every path that produces a distributable
// (#472). `start` deliberately stays fast and unchecked.
describe('forge prePackage hook', () => {
  it('typechecks before packaging the app', async () => {
    await config.hooks?.prePackage?.(config, '', '')

    expect(runTypecheck).toHaveBeenCalledTimes(1)
  })

  it('fails the packaging run when the typecheck fails', async () => {
    runTypecheck.mockImplementationOnce(() => {
      throw new Error('typecheck failed')
    })

    await expect(config.hooks?.prePackage?.(config, '', '')).rejects.toThrow(
      /typecheck failed/,
    )
  })
})

// @electron/packager wipes its base temp directory when a run starts, so two
// packaging runs sharing the default base delete each other's staging tree
// mid-run (#510). Every run therefore stages in its own directory.
describe('forge packaging temp directory', () => {
  it('stages the app in a directory of its own', () => {
    expect(config.packagerConfig.tmpdir).toBe('/tmp/streamwall-packager-test')
  })

  it('removes that directory once packaging is done', async () => {
    await config.hooks?.postPackage?.(config, {
      platform: 'darwin',
      arch: 'arm64',
      outputPaths: [],
    })

    expect(removePackagingTmpdir).toHaveBeenCalledWith(
      '/tmp/streamwall-packager-test',
    )
  })
})
