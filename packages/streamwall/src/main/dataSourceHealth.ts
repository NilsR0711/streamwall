import {
  DataSourceHealth,
  DataSourceType,
  MAX_DATA_SOURCE_MESSAGE_LENGTH,
} from 'streamwall-shared'

/**
 * Aggregates the latest health of each configured stream data source, keyed
 * by its id (the json-url or toml-file path), so a dead source is
 * diagnosable from the control UI instead of only from a log.
 */
export class DataSourceHealthTracker {
  private readonly byId = new Map<string, DataSourceHealth>()

  constructor(private readonly now: () => number = Date.now) {}

  report(
    id: string,
    type: DataSourceType,
    ok: boolean,
    message?: string,
  ): DataSourceHealth[] {
    this.byId.set(id, {
      id,
      type,
      status: ok ? 'ok' : 'error',
      // `message` forwards whatever the data source said back (issue #817),
      // entirely under that source's control -- truncate here, the same way
      // `formatError` does for view errors, so the schema's own bound is a
      // backstop rather than the only limit.
      message: ok
        ? null
        : (message?.slice(0, MAX_DATA_SOURCE_MESSAGE_LENGTH) ?? null),
      updatedAt: this.now(),
    })
    return [...this.byId.values()]
  }
}
