import { MakerDeb } from '@electron-forge/maker-deb'
import { MakerRpm } from '@electron-forge/maker-rpm'
import { MakerZIP } from '@electron-forge/maker-zip'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { VitePlugin } from '@electron-forge/plugin-vite'
import type { ForgeConfig } from '@electron-forge/shared-types'
import { FuseV1Options, FuseVersion } from '@electron/fuses'

import MakerNsis from './forge.makerNsis'
import { parseGithubRepository } from './forge.publisher'
import {
  getMacSigningConfig,
  getWindowsSigningConfig,
  isSigningConfigured,
} from './forge.signing'
import { runTypecheck } from './forge.typecheck'
import { appendUpdateMetadata } from './forge.updateMetadata'
import packageJson from './package.json'

const macSigning = getMacSigningConfig(process.env)
const windowsSigning = getWindowsSigningConfig(process.env)
const signingConfigured = isSigningConfigured(process.env)
const publishRepository = parseGithubRepository(packageJson.repository)

const config: ForgeConfig = {
  packagerConfig: {
    // No explicit executableName: it defaults to the product name
    // ("Streamwall"), which the NSIS installer template requires the
    // executable to match. The Linux makers still install a lowercase
    // `streamwall` command via their `bin` option below.
    asar: true,
    ...macSigning,
  },
  rebuildConfig: {},
  makers: [
    // NSIS instead of Squirrel.Windows (#432): electron-updater - which
    // provides the user-gated download and byte-level progress - only
    // supports NSIS installers on Windows.
    new MakerNsis({ ...windowsSigning }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({ options: { bin: 'Streamwall' } }),
    new MakerDeb({ options: { bin: 'Streamwall' } }),
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: publishRepository,
        // Publish as a normal (non-prerelease) release so it becomes the
        // repo's "Latest release": GitHub's latest-release logic — and the
        // homepage sidebar "Releases" box — deliberately ignores
        // prereleases, so a prerelease-only repo shows just a tag count.
        prerelease: false,
      },
    },
  ],
  hooks: {
    // Vite strips types without checking them, so packaging would otherwise
    // emit a release artifact from code that does not compile (#472). `make`
    // and `publish` both run the package step, so this one hook covers every
    // command that produces a distributable; `start` stays unchecked to keep
    // the dev loop fast (`npm run typecheck` still covers it in CI).
    prePackage: async () => runTypecheck(),
    // latest.yml / latest-mac.yml for electron-updater (#432); uploaded to
    // the release alongside the installers by the GitHub publisher.
    postMake: async (_forgeConfig, makeResults) =>
      appendUpdateMetadata(makeResults),
  },
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
