// Public surface of the data-source layer, split by responsibility (#582):
// URL polling (`poll`), file watching (`watchFile`), payload parsing and
// stream identity (`parse`), the per-source combinator (`combine`), and the
// in-memory local/preset sources (`local`). Consumers import from './data'
// and are unaffected by the internal layout.
export {
  OVERLAY_DATA_SOURCE_NAME,
  combineDataSources,
  markDataSource,
} from './combine'
export { LocalStreamData, presetDataSource } from './local'
export { StreamIDGenerator } from './parse'
export {
  MAX_FETCH_TIMEOUT_MS,
  MIN_FETCH_TIMEOUT_MS,
  computeFetchTimeoutMs,
  pollDataURL,
} from './poll'
export type { DataSourceHealthCallback } from './types'
export { watchDataFile } from './watchFile'
