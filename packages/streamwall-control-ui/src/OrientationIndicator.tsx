import {
  MdOutlineStayCurrentLandscape,
  MdOutlineStayCurrentPortrait,
} from 'react-icons/md'

export function OrientationIndicator({
  orientation,
  className,
}: {
  orientation: 'V' | 'H' | null | undefined
  className?: string
}) {
  if (orientation === 'V') {
    return (
      <span className={className}>
        <MdOutlineStayCurrentPortrait />
      </span>
    )
  } else if (orientation === 'H') {
    return (
      <span className={className}>
        <MdOutlineStayCurrentLandscape />
      </span>
    )
  } else {
    return null
  }
}
