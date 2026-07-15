import fs from 'node:fs'
import exampleConfigToml from '../../../../example.config.toml?raw'

/**
 * Writes the bundled example.config.toml verbatim to `configPath`. Uses the
 * 'wx' flag so this atomically fails instead of silently overwriting a file
 * that raced into existence between a hasUserConfig check and this write
 * (#246).
 */
export function createExampleConfig(configPath: string): void {
  fs.writeFileSync(configPath, exampleConfigToml, { flag: 'wx' })
}
