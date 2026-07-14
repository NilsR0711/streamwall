import { truncate } from 'lodash-es'
import { type JSX } from 'preact'
import { useCallback, useState } from 'preact/hooks'
import {
  Color,
  idColor,
  type ContentKind,
  type LocalStreamData,
  type StreamData,
} from 'streamwall-shared'
import { styled } from 'styled-components'
import { type ColorInstance } from './colorTypes.ts'
import { LazyChangeInput } from './LazyChangeInput.tsx'
import { OrientationIndicator } from './OrientationIndicator.tsx'

const StyledId = styled.div<{ $color: ColorInstance; $disabled?: boolean }>`
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.02em;
  background: ${({ $color }) =>
    Color($color).lightness(52).hsl().string() || '#333'};
  color: #0a0d12;
  padding: 4px 0;
  border-radius: var(--r-sm);
  width: 2.6em;
  text-align: center;
  cursor: ${({ $disabled }) => ($disabled ? 'normal' : 'grab')};
`

const StyledStreamLine = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: var(--r-sm);
  border: 1px solid transparent;
  font-size: 13px;
  cursor: default;

  &:hover {
    background: var(--surface-2);
    border-color: var(--border);
  }

  & > div {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }

  svg {
    height: 100%;
  }
`

function StreamLine({
  id,
  row: { label, source, link, notes, city, state, orientation },
  disabled,
  onClickId,
}: {
  id: string
  row: StreamData
  disabled: boolean
  onClickId: (id: string) => void
}) {
  // Use mousedown instead of click event so a potential destination grid input stays focused.
  const handleMouseDownId = useCallback(() => {
    onClickId(id)
  }, [onClickId, id])
  return (
    <StyledStreamLine>
      <StyledId
        $disabled={disabled}
        onMouseDown={disabled ? undefined : handleMouseDownId}
        $color={idColor(id)}
      >
        {id}
      </StyledId>
      <div>
        {label ? (
          label
        ) : (
          <>
            <strong>{source}</strong>{' '}
            <OrientationIndicator orientation={orientation} />{' '}
            {city ? `(${city} ${state}) ` : ''}
            <a href={link} target="_blank">
              {truncate(link, { length: 55 })}
            </a>{' '}
            {notes}
          </>
        )}
      </div>
    </StyledStreamLine>
  )
}

export function StreamList({
  rows,
  disabled,
  onClickId,
}: {
  rows: StreamData[]
  disabled: boolean
  onClickId: (id: string) => void
}) {
  return rows.map((row) => (
    <StreamLine
      key={row._id}
      id={row._id}
      row={row}
      disabled={disabled}
      onClickId={onClickId}
    />
  ))
}

export function CustomStreamInput({
  onChange,
  onDelete,
  ...props
}: {
  onChange: (link: string, data: LocalStreamData) => void
  onDelete: (link: string) => void
} & LocalStreamData) {
  const handleChangeLabel = useCallback(
    (value: string) => {
      onChange(props.link, { ...props, label: value })
    },
    [onChange, props],
  )

  const handleDeleteClick = useCallback(() => {
    onDelete(props.link)
  }, [onDelete, props.link])

  return (
    <div>
      <LazyChangeInput
        value={props.label ?? ''}
        onChange={handleChangeLabel}
        placeholder="Label (optional)"
      />{' '}
      <a href={props.link}>{props.link}</a> <span>({props.kind})</span>{' '}
      <button onClick={handleDeleteClick}>x</button>
    </div>
  )
}

export function CreateCustomStreamInput({
  onCreate,
}: {
  onCreate: (link: string, data: LocalStreamData) => void
}) {
  const [link, setLink] = useState('')
  const [kind, setKind] = useState<ContentKind>('video')
  const [label, setLabel] = useState('')
  const handleSubmit = useCallback<JSX.SubmitEventHandler<HTMLFormElement>>(
    (ev) => {
      ev.preventDefault()
      onCreate(link, { link, kind, label })
      setLink('')
      setKind('video')
      setLabel('')
    },
    [onCreate, link, kind, label],
  )
  return (
    <form onSubmit={handleSubmit}>
      <input
        value={link}
        onChange={(ev) => setLink(ev.currentTarget.value)}
        placeholder="https://..."
      />
      <select
        onChange={(ev) => setKind(ev.currentTarget.value as ContentKind)}
        value={kind}
      >
        <option value="video">video</option>
        <option value="audio">audio</option>
        <option value="web">web</option>
        <option value="overlay">overlay</option>
        <option value="background">background</option>
      </select>
      <input
        value={label}
        onChange={(ev) => setLabel(ev.currentTarget.value)}
        placeholder="Label (optional)"
      />
      <button type="submit">add stream</button>
    </form>
  )
}
