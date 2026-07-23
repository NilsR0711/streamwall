import { useEffect, useState } from 'preact/hooks'
import { z } from 'zod'

/**
 * Shape of `GET /admin/status` (mirrors the server's `UpdateStatus` in
 * `streamwall-control-server/src/updateCheck.ts`). Validated at runtime because
 * this is a cross-boundary payload; a malformed body yields no status rather
 * than a mistyped object leaking into the UI.
 */
export const serverStatusSchema = z.object({
  version: z.string(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  releaseUrl: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  checkEnabled: z.boolean(),
})

export type ServerStatus = z.infer<typeof serverStatusSchema>

/**
 * How often to revalidate `/admin/status` while enabled. The server refreshes
 * its update check daily, so an hourly poll is more than frequent enough to
 * surface a new "update available" notice to an operator whose control UI has
 * been open for days, without meaningfully adding load (#624).
 */
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000

/**
 * Abort a single `/admin/status` request after this long so a hung fetch can
 * never leave `status` stuck for the whole session; the next interval simply
 * tries again.
 */
export const FETCH_TIMEOUT_MS = 10 * 1000

/**
 * Fetches `GET /admin/status` (#430) while `enabled`, then revalidates on an
 * interval so long-lived sessions still pick up a newly published update
 * (#624). The endpoint is admin-only and returns a bare 403 for every other
 * role/anonymous request; that's treated the same as any other failure (no
 * status), since callers are expected to only set `enabled` once they already
 * know the role can see it (#436) - a 403 here just means that check raced a
 * role change.
 */
export function useServerStatus(enabled: boolean): ServerStatus | null {
  const [status, setStatus] = useState<ServerStatus | null>(null)

  useEffect(() => {
    if (!enabled) {
      setStatus(null)
      return
    }

    let cancelled = false
    let activeController: AbortController | null = null

    const load = () => {
      // Supersede any still-inflight request so overlapping polls can't race.
      activeController?.abort()
      const controller = new AbortController()
      activeController = controller
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      fetch('/admin/status', {
        credentials: 'same-origin',
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (cancelled || controller !== activeController) {
            return
          }
          const parsed = serverStatusSchema.safeParse(data)
          setStatus(parsed.success ? parsed.data : null)
        })
        .catch(() => {
          // Network error, timeout, or unmount abort: keep the last known-good
          // status (if any) so a single transient failure doesn't blank the
          // version label / update banner; the next interval retries.
        })
        .finally(() => {
          clearTimeout(timeout)
        })
    }

    load()
    const interval = setInterval(load, REFRESH_INTERVAL_MS)

    return () => {
      cancelled = true
      activeController?.abort()
      clearInterval(interval)
    }
  }, [enabled])

  return status
}
