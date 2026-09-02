import type { ForgeConfig } from '@electron-forge/shared-types'
import { describe, expect, it, vi } from 'vitest'

const runTypecheck = vi.fn()
vi.mock('./forge.typecheck', () => ({ runTypecheck: () => runTypecheck() }))

let nextTmpdir = 0
const createPackagingTmpdir = vi.fn(
  () => `/tmp/streamwall-packager-${nextTmpdir++}`,
)
const removePackagingTmpdir = vi.fn()
const unregisterFallbackCleanup = vi.fn()
const registerPackagingTmpdirFallbackCleanup = vi.fn(
  () => unregisterFallbackCleanup,
)
vi.mock('./forge.tmpdir', () => ({
  createPackagingTmpdir: () => createPackagingTmpdir(),
  removePackagingTmpdir: (dir: string) => removePackagingTmpdir(dir),
  registerPackagingTmpdirFallbackCleanup: (dir: string) =>
    registerPackagingTmpdirFallbackCleanup(dir),
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

  // #749: loading this config (e.g. for `electron-forge start`, or for the
  // typecheck-failure case above) must never create a tmpdir that would then
  // need cleaning up. Only a `prePackage` hook that gets past the typecheck
  // creates one.
  it('never creates a packaging tmpdir when the typecheck fails', async () => {
    createPackagingTmpdir.mockClear()
    runTypecheck.mockImplementationOnce(() => {
      throw new Error('typecheck failed')
    })

    await expect(config.hooks?.prePackage?.(config, '', '')).rejects.toThrow(
      /typecheck failed/,
    )

    expect(createPackagingTmpdir).not.toHaveBeenCalled()
  })
})

// @electron/packager wipes its base temp directory when a run starts, so two
// packaging runs sharing the default base delete each other's staging tree
// mid-run (#510). Every run therefore stages in its own directory, created
// once `prePackage` actually runs rather than at module load (#749).
describe('forge packaging temp directory', () => {
  it('stages the app in a directory of its own once prePackage runs', async () => {
    createPackagingTmpdir.mockClear()

    await config.hooks?.prePackage?.(config, '', '')

    expect(createPackagingTmpdir).toHaveBeenCalledTimes(1)
    expect(config.packagerConfig.tmpdir).toBe(
      await createPackagingTmpdir.mock.results[0]?.value,
    )
  })

  // A run that fails after prePackage has already staged a directory but
  // before postPackage runs (e.g. the packaging step itself throwing) would
  // otherwise strand that directory; a process-exit fallback stands in for
  // the cleanup postPackage never gets to perform (#749).
  it('registers a process-exit fallback cleanup once a directory is staged', async () => {
    registerPackagingTmpdirFallbackCleanup.mockClear()

    await config.hooks?.prePackage?.(config, '', '')

    expect(registerPackagingTmpdirFallbackCleanup).toHaveBeenCalledWith(
      config.packagerConfig.tmpdir,
    )
  })

  it('removes that directory and stands down the fallback once packaging is done', async () => {
    await config.hooks?.prePackage?.(config, '', '')
    const tmpdir = config.packagerConfig.tmpdir
    unregisterFallbackCleanup.mockClear()
    removePackagingTmpdir.mockClear()

    await config.hooks?.postPackage?.(config, {
      platform: 'darwin',
      arch: 'arm64',
      outputPaths: [],
    })

    expect(unregisterFallbackCleanup).toHaveBeenCalledTimes(1)
    expect(removePackagingTmpdir).toHaveBeenCalledWith(tmpdir)
  })

  // `make` can run this packaging pipeline more than once in the same
  // process (e.g. across multiple platform/arch targets), so a second
  // prePackage/postPackage cycle must not reuse or double-free the first
  // cycle's directory.
  it('stages and removes a fresh directory on each successive prePackage/postPackage cycle', async () => {
    removePackagingTmpdir.mockClear()
    await config.hooks?.prePackage?.(config, '', '')
    const firstTmpdir = config.packagerConfig.tmpdir
    await config.hooks?.postPackage?.(config, {
      platform: 'darwin',
      arch: 'arm64',
      outputPaths: [],
    })

    await config.hooks?.prePackage?.(config, '', '')
    const secondTmpdir = config.packagerConfig.tmpdir
    await config.hooks?.postPackage?.(config, {
      platform: 'linux',
      arch: 'x64',
      outputPaths: [],
    })

    expect(secondTmpdir).not.toBe(firstTmpdir)
    expect(removePackagingTmpdir).toHaveBeenCalledWith(firstTmpdir)
    expect(removePackagingTmpdir).toHaveBeenCalledWith(secondTmpdir)
    expect(removePackagingTmpdir).toHaveBeenCalledTimes(2)
  })

  it('does nothing on postPackage when no directory was ever staged', async () => {
    // Simulates postPackage running without a preceding prePackage having
    // created a directory - not a real forge sequence, but the hook must
    // stay defensive rather than assume prePackage always ran first. Uses a
    // fresh module instance so this test does not depend on the shared
    // `config` singleton's state left over from earlier tests in this file.
    vi.resetModules()
    removePackagingTmpdir.mockClear()
    const { default: freshConfig }: { default: ForgeConfig } =
      await import('./forge.config')

    await freshConfig.hooks?.postPackage?.(freshConfig, {
      platform: 'darwin',
      arch: 'arm64',
      outputPaths: [],
    })

    expect(removePackagingTmpdir).not.toHaveBeenCalled()
  })
})
