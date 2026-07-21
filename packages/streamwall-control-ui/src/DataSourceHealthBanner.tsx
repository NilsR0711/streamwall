import { FaExclamationTriangle } from 'react-icons/fa'
import { type DataSourceHealth } from 'streamwall-shared'
import { styled } from 'styled-components'

const StyledDataSourceHealthBanner = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;

  .data-source-health-warning {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #e0a800;
  }
`

const LABEL_BY_TYPE: Record<DataSourceHealth['type'], string> = {
  'json-url': 'Data source unreachable',
  'toml-file': 'Data file unreadable',
}

/**
 * Surfaces a dead `--data.json-url`/`--data.toml-file` in the control UI,
 * naming the failing source, so it's diagnosable without reading the log
 * (issue #85).
 *
 * The live region itself stays mounted while every source is healthy and only
 * its contents are swapped: `aria-live` announcements are only reliable for
 * changes inside a region that already exists in the accessibility tree, so
 * mounting the region together with its first warning risks losing exactly
 * that first announcement (WCAG 4.1.3, issue #463).
 */
export function DataSourceHealthBanner({
  dataSourceHealth,
}: {
  dataSourceHealth: DataSourceHealth[]
}) {
  const failing = dataSourceHealth.filter((health) => health.status === 'error')

  return (
    <StyledDataSourceHealthBanner role="status" aria-live="polite">
      {failing.map((health) => (
        <span
          className="data-source-health-warning"
          key={health.id}
          title={health.message ?? undefined}
        >
          <FaExclamationTriangle />
          {LABEL_BY_TYPE[health.type]}: {health.id}
        </span>
      ))}
    </StyledDataSourceHealthBanner>
  )
}
