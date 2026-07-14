import { DataSourceHealth, DataSourceType } from 'streamwall-shared'

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
      message: ok ? null : (message ?? null),
      updatedAt: this.now(),
    })
    return [...this.byId.values()]
  }
}
