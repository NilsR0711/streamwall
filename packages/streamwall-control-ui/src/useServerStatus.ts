import { useEffect, useState } from 'preact/hooks'

export interface ServerStatus {
  version: string
  latestVersion: string | null
  updateAvailable: boolean
  releaseUrl: string | null
  lastCheckedAt: string | null
  checkEnabled: boolean
}

/**
 * Fetches `GET /admin/status` (#430) while `enabled`. The endpoint is
 * admin-only and returns a bare 403 for every other role/anonymous request;
 * that's treated the same as any other failure (no status), since callers
 * are expected to only set `enabled` once they already know the role can
 * see it (#436) - a 403 here just means that check raced a role change.
 */
export function useServerStatus(enabled: boolean): ServerStatus | null {
  const [status, setStatus] = useState<ServerStatus | null>(null)

  useEffect(() => {
    if (!enabled) {
      setStatus(null)
      return
    }

    let cancelled = false
    fetch('/admin/status', { credentials: 'same-origin' })
      .then((res) => (res.ok ? (res.json() as Promise<ServerStatus>) : null))
      .then((data) => {
        if (!cancelled) {
          setStatus(data)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [enabled])

  return status
}
