import type { ForgeConfig } from '@electron-forge/shared-types'
import { describe, expect, it, vi } from 'vitest'

const runTypecheck = vi.fn()
vi.mock('./forge.typecheck', () => ({ runTypecheck: () => runTypecheck() }))

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
