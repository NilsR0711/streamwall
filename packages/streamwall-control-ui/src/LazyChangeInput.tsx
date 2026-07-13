import { type JSX } from 'preact'
import { useCallback, useState } from 'preact/hooks'

// An input that maintains local edits and fires onChange after blur (like a non-React input does), or optionally on every edit if isEager is set.
export function LazyChangeInput({
  value = '',
  onChange,
  isEager = false,
  ...props
}: {
  value: string
  isEager?: boolean
  onChange: (value: string) => void
} & Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'onChange'>) {
  const [editingValue, setEditingValue] = useState<string>()
  const handleFocus = useCallback<JSX.FocusEventHandler<HTMLInputElement>>(
    (ev) => {
      if (ev.target instanceof HTMLInputElement) {
        setEditingValue(ev.target.value)
      }
    },
    [],
  )

  const handleBlur = useCallback(() => {
    if (!isEager && editingValue !== undefined) {
      onChange(editingValue)
    }
    setEditingValue(undefined)
  }, [editingValue, isEager, onChange])

  const handleKeyDown = useCallback<JSX.KeyboardEventHandler<HTMLInputElement>>(
    (ev) => {
      if (ev.key === 'Enter') {
        handleBlur()
      }
    },
    [handleBlur],
  )

  const handleChange = useCallback<JSX.InputEventHandler<HTMLInputElement>>(
    (ev) => {
      const { value } = ev.currentTarget
      setEditingValue(value)
      if (isEager) {
        onChange(value)
      }
    },
    [onChange, isEager],
  )

  return (
    <input
      value={editingValue !== undefined ? editingValue : value}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onChange={handleChange}
      {...props}
    />
  )
}
