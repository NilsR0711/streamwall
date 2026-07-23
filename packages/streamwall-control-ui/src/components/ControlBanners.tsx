import {
  type DataSourceHealth,
  type DisconnectReason,
  type ServerStatus,
} from 'streamwall-shared'
import { CommandErrorBanner } from '../CommandErrorBanner.tsx'
import { ConnectionStatusBanner } from '../ConnectionStatusBanner.tsx'
import { DataSourceHealthBanner } from '../DataSourceHealthBanner.tsx'
import { ServerUpdateBanner } from '../ServerUpdateBanner.tsx'

/**
 * The stack of transient status banners shown above the wall: connection
 * state, data-source health, an available server update, and surfaced command
 * errors. Grouped from ControlUI's composition root unchanged (issue #393).
 */
export function ControlBanners({
  isConnected,
  disconnectReason,
  dataSourceHealth,
  serverStatus,
  commandError,
  onDismissError,
}: {
  isConnected: boolean
  disconnectReason: DisconnectReason | null | undefined
  dataSourceHealth: DataSourceHealth[]
  serverStatus: ServerStatus | null
  commandError: string | null
  onDismissError: () => void
}) {
  return (
    <>
      <ConnectionStatusBanner
        isConnected={isConnected}
        reason={disconnectReason}
      />
      <DataSourceHealthBanner dataSourceHealth={dataSourceHealth} />
      <ServerUpdateBanner status={serverStatus} />
      <CommandErrorBanner error={commandError} onDismiss={onDismissError} />
    </>
  )
}
