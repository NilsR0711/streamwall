import type { StreamDataContent } from '../../../streamwall-shared/src/types'

/**
 * Validate and normalize an untrusted stream-data payload (e.g. from a remote
 * json-url or a watched toml-file) into a list of usable entries.
 *
 * Data sources are operator-supplied and can return malformed data: a
 * non-array wrapper object, null/primitive entries, or entries without a
 * link. Such payloads previously propagated into the data pipeline and
 * crashed the whole app (a non-iterable or a property access on a non-object
 * throws, rejecting `main()` and triggering `process.exit(1)`). This drops
 * anything that isn't a well-formed entry with a non-empty string link, so a
 * bad source degrades to "no streams" instead of killing the process.
 */
export function sanitizeStreamDataList(payload: unknown): StreamDataContent[] {
  if (!Array.isArray(payload)) {
    return []
  }
  return payload.filter(
    (entry): entry is StreamDataContent =>
      entry != null &&
      typeof entry === 'object' &&
      typeof (entry as { link?: unknown }).link === 'string' &&
      (entry as { link: string }).link.length > 0,
  )
}
