import { StreamDataContent } from '../../../../streamwall-shared/src/types'

export type DataSource = AsyncIterableIterator<StreamDataContent[]>

// Reports whether the most recent read of a data source succeeded, so a
// caller can surface a dead json-url/toml-file from the UI instead of it
// only being diagnosable from a log.
export type DataSourceHealthCallback = (ok: boolean, message?: string) => void
