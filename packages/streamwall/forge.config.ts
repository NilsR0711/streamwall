import { MakerDeb } from '@electron-forge/maker-deb'
import { MakerRpm } from '@electron-forge/maker-rpm'
import { MakerSquirrel } from '@electron-forge/maker-squirrel'
import { MakerZIP } from '@electron-forge/maker-zip'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { VitePlugin } from '@electron-forge/plugin-vite'
import type { ForgeConfig } from '@electron-forge/shared-types'
import { FuseV1Options, FuseVersion } from '@electron/fuses'

import { parseGithubRepository } from './forge.publisher'
import {
  getMacSigningConfig,
  getWindowsSigningConfig,
  isSigningConfigured,
} from './forge.signing'
import packageJson from './package.json'

const macSigning = getMacSigningConfig(process.env)
const windowsSigning = getWindowsSigningConfig(process.env)
const signingConfigured = isSigningConfigured(process.env)
const publishRepository = parseGithubRepository(packageJson.repository)

const config: ForgeConfig = {
  packagerConfig: {
    executableName: 'streamwall',
    asar: true,
    ...macSigning,
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ ...windowsSigning }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: publishRepository,
        prerelease: true,
      },
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/layerPreload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/preload/mediaPreload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/preload/controlPreload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // ASAR integrity validation only holds up once the app itself is
      // signed (otherwise the embedded hash can be stripped along with the
      // signature), so only turn these on for signed builds.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: signingConfigured,
      [FuseV1Options.OnlyLoadAppFromAsar]: signingConfigured,
    }),
  ],
}

export default config
