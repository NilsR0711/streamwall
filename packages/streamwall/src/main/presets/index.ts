import { parseStreamList, type StreamDataInput } from 'streamwall-shared'
import log from '../logger'
import deTvEntries from './de-tv.json'

export interface PresetPack {
  id: string
  name: string
  entries: StreamDataInput[]
}

interface PresetPackDefinition {
  name: string
  rawEntries: unknown[]
}

/** Built-in preset packs, keyed by the id an operator references via the `presets` config/CLI option. */
const packDefinitions: Record<string, PresetPackDefinition> = {
  'de-tv': { name: 'German Free-TV', rawEntries: deTvEntries },
}

/**
 * Validates `rawEntries` the same way any other stream data source is
 * validated, dropping and logging invalid entries rather than failing the
 * whole pack. Exported separately from `loadPresetPack` so this tolerance
 * behavior is directly testable without needing to inject a malformed
 * bundled file.
 */
export function buildPresetPack(
  id: string,
  name: string,
  rawEntries: unknown,
): PresetPack {
  const { streams, errors } = parseStreamList(rawEntries)
  if (errors.length) {
    log.warn(
      `ignoring ${errors.length} invalid entr${errors.length === 1 ? 'y' : 'ies'} in preset pack "${id}"`,
    )
  }
  return { id, name, entries: streams }
}

/**
 * Loads and validates a built-in preset pack by id. Returns undefined for an
 * unknown pack id so the caller can warn and skip it rather than crash
 * startup over an operator typo in the `presets` config/CLI option.
 */
export function loadPresetPack(id: string): PresetPack | undefined {
  const definition = packDefinitions[id]
  if (!definition) {
    return undefined
  }
  return buildPresetPack(id, definition.name, definition.rawEntries)
}
