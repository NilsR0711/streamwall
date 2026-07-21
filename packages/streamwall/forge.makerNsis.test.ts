import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildNsisPackagerOptions } from './forge.makerNsis'

const makeContext = {
  dir: '/tmp/out/Streamwall-win32-x64',
  makeDir: '/tmp/out/make',
  targetArch: 'x64' as const,
}

describe('buildNsisPackagerOptions', () => {
  it('points electron-builder at the forge-packaged app instead of repacking', () => {
    const options = buildNsisPackagerOptions(makeContext, {})

    expect(options.prepackaged).toBe(path.resolve(makeContext.dir))
  })

  it('never publishes from the maker, leaving uploads to the forge GitHub publisher', () => {
    const options = buildNsisPackagerOptions(makeContext, {})

    expect(options.publish).toBe('never')
  })

  it('writes the installer into an arch-scoped make subdirectory like other makers', () => {
    const options = buildNsisPackagerOptions(makeContext, {})

    expect(options.config).toMatchObject({
      directories: { output: path.join('/tmp/out/make', 'nsis', 'x64') },
    })
  })

  it('names the installer without spaces, since GitHub Releases mangles asset names containing them', () => {
    const options = buildNsisPackagerOptions(makeContext, {})

    expect(options.config).toMatchObject({
      nsis: { artifactName: '${name}-setup-${version}.${ext}' },
    })
  })

  it('pins the appId so updates keep installing over the same identity', () => {
    const options = buildNsisPackagerOptions(makeContext, {})

    expect(options.config).toMatchObject({ appId: 'com.electron.streamwall' })
  })

  it('passes the signing certificate through when configured', () => {
    const options = buildNsisPackagerOptions(makeContext, {
      certificateFile: '/secrets/cert.pfx',
      certificatePassword: 'hunter2',
    })

    expect(options.config).toMatchObject({
      win: {
        signtoolOptions: {
          certificateFile: '/secrets/cert.pfx',
          certificatePassword: 'hunter2',
        },
      },
    })
  })

  it('leaves builds unsigned when no certificate is configured, as before', () => {
    const options = buildNsisPackagerOptions(makeContext, {})

    expect(options.config).not.toHaveProperty('win')
  })
})
