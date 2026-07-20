import { MakerBase, type MakerOptions } from '@electron-forge/maker-base'
import type { ForgePlatform } from '@electron-forge/shared-types'
import type { Configuration, PackagerOptions } from 'app-builder-lib'
import path from 'node:path'
import type { WindowsSigningConfig } from './forge.signing'

/**
 * Windows NSIS maker (#432), wrapping electron-builder's prepackaged mode.
 *
 * electron-updater's Windows client only understands NSIS installers - it
 * dropped Squirrel.Windows support, and forge has no first-party NSIS maker -
 * so this replaces `@electron-forge/maker-squirrel`: forge still packages the
 * app (Vite plugin, fuses, ASAR), and electron-builder only wraps the
 * already-packaged directory into the installer.
 */

export type MakerNsisConfig = Partial<WindowsSigningConfig>

/**
 * Derives the electron-builder invocation from forge's make context. Pure, so
 * the mapping is testable without running a build.
 */
export function buildNsisPackagerOptions(
  options: Pick<MakerOptions, 'dir' | 'makeDir' | 'targetArch'>,
  config: MakerNsisConfig,
): PackagerOptions & { publish: 'never' } {
  const builderConfig: Configuration = {
    // Freezes electron-builder's documented default: NSIS derives the
    // per-machine install/registry identity from the appId, so it must never
    // drift between releases or updates would install side-by-side.
    appId: 'com.electron.streamwall',
    directories: {
      output: path.join(options.makeDir, 'nsis', options.targetArch),
    },
    // No spaces: GitHub Releases mangles asset names containing spaces
    // (the default "Streamwall Setup x.y.z.exe" became
    // "Streamwall-x.y.z.Setup.exe" for the Squirrel installer), which would
    // break the URL match against latest.yml (see forge.updateMetadata.ts).
    nsis: {
      artifactName: '${name}-setup-${version}.${ext}',
    },
    ...(config.certificateFile && config.certificatePassword
      ? {
          win: {
            signtoolOptions: {
              certificateFile: config.certificateFile,
              certificatePassword: config.certificatePassword,
            },
          },
        }
      : {}),
  }

  return {
    // Forge already packaged the app; electron-builder must not repack it.
    prepackaged: path.resolve(options.dir),
    config: builderConfig,
    // Publishing stays @electron-forge/publisher-github's job.
    publish: 'never',
  }
}

export default class MakerNsis extends MakerBase<MakerNsisConfig> {
  name = 'nsis'

  defaultPlatforms: ForgePlatform[] = ['win32']

  // electron-builder bundles makensis for every host OS, so win32 installers
  // can also be cross-built (e.g. a local smoke test on macOS).
  isSupportedOnCurrentPlatform(): boolean {
    return true
  }

  async make(options: MakerOptions): Promise<string[]> {
    const { Arch, Platform, build } = await import('app-builder-lib')
    const arch = Arch[options.targetArch as keyof typeof Arch] ?? Arch.x64
    const artifacts = await build({
      ...buildNsisPackagerOptions(options, this.config),
      targets: Platform.WINDOWS.createTarget('nsis', arch),
    })
    // electron-builder may emit its own latest.yml when it can infer a
    // publish target; forge.updateMetadata.ts is the single source for that
    // file, so only the installer artifacts are reported.
    return artifacts.filter((artifact) => !artifact.endsWith('.yml'))
  }
}
