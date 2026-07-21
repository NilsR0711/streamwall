import { type DataSourceType } from 'streamwall-shared'
import {
  type DataSourceHealthCallback,
  type LocalStreamData,
  OVERLAY_DATA_SOURCE_NAME,
  markDataSource,
  pollDataURL,
  presetDataSource,
  watchDataFile,
} from './data'
import log from './logger'
import { loadPresetPack } from './presets'

/** A marked, ready-to-combine data source (as produced by `markDataSource`). */
type DataSource = ReturnType<typeof markDataSource>

export interface BuildDataSourcesInput {
  /** URLs polled for stream data (`--data.json-url`). */
  jsonUrls: string[]
  /** TOML files watched for stream data (`--data.toml-file`). */
  tomlFiles: string[]
  /** Enabled built-in preset pack ids (`--presets`). */
  presets: string[]
  /** Poll interval (seconds) for the URL sources. */
  interval: number
  /** Operator-defined custom streams source. */
  localStreamData: Pick<LocalStreamData, 'gen'>
  /** Overlay (rotate-stream) source. */
  overlayStreamData: Pick<LocalStreamData, 'gen'>
  /** Builds a health reporter for a data source of the given id and type. */
  trackDataSourceHealth: (
    id: string,
    type: DataSourceType,
  ) => DataSourceHealthCallback
}

/**
 * Assembles every data source feeding the wall: polled URLs, watched TOML
 * files, enabled preset packs, and the always-present custom and overlay
 * sources. Unknown preset ids are warned about and skipped rather than failing
 * startup.
 *
 * The sources are lazy — no polling, file watching, or network I/O happens
 * until they are iterated by `combineDataSources`.
 */
export function buildDataSources({
  jsonUrls,
  tomlFiles,
  presets,
  interval,
  localStreamData,
  overlayStreamData,
  trackDataSourceHealth,
}: BuildDataSourcesInput): DataSource[] {
  return [
    ...jsonUrls.map((url) => {
      log.debug('Setting data source from json-url:', url)
      return markDataSource(
        pollDataURL(url, interval, trackDataSourceHealth(url, 'json-url')),
        'json-url',
      )
    }),
    ...tomlFiles.map((path) => {
      log.debug('Setting data source from toml-file:', path)
      return markDataSource(
        watchDataFile(path, trackDataSourceHealth(path, 'toml-file')),
        'toml-file',
      )
    }),
    ...presets.flatMap((packId) => {
      const pack = loadPresetPack(packId)
      if (!pack) {
        log.warn(`Unknown preset pack "${packId}", skipping`)
        return []
      }
      log.debug('Loading preset pack:', pack.id)
      return [markDataSource(presetDataSource(pack), `preset:${pack.id}`)]
    }),
    markDataSource(localStreamData.gen(), 'custom'),
    markDataSource(overlayStreamData.gen(), OVERLAY_DATA_SOURCE_NAME),
  ]
}
