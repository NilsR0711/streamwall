import Color from 'color'
import {
  FaExclamationTriangle,
  FaFacebook,
  FaInstagram,
  FaMapMarkerAlt,
  FaTiktok,
  FaTwitch,
  FaVolumeUp,
  FaYoutube,
} from 'react-icons/fa'
import { RiKickFill, RiTwitterXFill } from 'react-icons/ri'
import type { StreamData } from 'streamwall-shared'
import { styled } from 'styled-components'
import { TailSpin } from './TailSpin'

// Extracted from overlay.tsx so it can be rendered and tested in isolation,
// without pulling in the module-level `render(<App />, document.body)` call.
export function OverlayViewTile({
  url,
  data,
  isError,
  errorReason,
  isListening,
  isBackgroundListening,
  isBlurred,
  isLoading,
  activeColor,
}: {
  url: string
  data: StreamData | undefined
  isError: boolean
  errorReason: string | null | undefined
  isListening: boolean
  isBackgroundListening: boolean
  isBlurred: boolean
  isLoading: boolean
  activeColor: string
}) {
  const hasTitle = data && (data.label || data.source)
  const position = data?.labelPosition ?? 'top-left'
  const label = data?.label || data?.source

  if (isError) {
    return (
      <ErrorCover>
        <ErrorIcon>
          <FaExclamationTriangle />
        </ErrorIcon>
        <ErrorHeading>
          <StreamIcon url={url} />
          <span>{label ?? 'Stream error'}</span>
        </ErrorHeading>
        {errorReason && <ErrorReason>{errorReason}</ErrorReason>}
      </ErrorCover>
    )
  }

  return (
    <>
      <FilterCover $isBlurred={isBlurred} $isDesaturated={isLoading} />
      {hasTitle && (
        <StreamTitle
          $position={position}
          $activeColor={activeColor}
          $isListening={isListening}
        >
          <StreamIcon url={url} />
          <span>{data.label ? data.label : <>{data.source}</>}</span>
          {(isListening || isBackgroundListening) && <FaVolumeUp />}
        </StreamTitle>
      )}
      {data?.city && (
        <StreamLocation>
          <FaMapMarkerAlt />
          <span>
            {data.city} {data.state}
          </span>
        </StreamLocation>
      )}
      <LoadingSpinner $isVisible={isLoading} />
    </>
  )
}

function StreamIcon({ url }: { url: string }) {
  let parsedURL
  try {
    parsedURL = new URL(url)
  } catch {
    return null
  }

  let { host } = parsedURL
  host = host.replace(/^www\./, '')
  if (host === 'youtube.com' || host === 'youtu.be') {
    return <FaYoutube />
  } else if (host === 'facebook.com' || host === 'm.facebook.com') {
    return <FaFacebook />
  } else if (host === 'twitch.tv') {
    return <FaTwitch />
  } else if (host === 'instagram.com') {
    return <FaInstagram />
  } else if (host === 'tiktok.com') {
    return <FaTiktok />
  } else if (host === 'kick.com') {
    return <RiKickFill />
  } else if (host === 'x.com') {
    return <RiTwitterXFill />
  }
  return null
}

const StreamTitle = styled.div<{
  $position: StreamData['labelPosition']
  $isListening: boolean
  $activeColor: string
}>`
  position: absolute;
  ${({ $position }) => {
    if ($position === 'top-left') {
      return `top: 0; left: 0;`
    } else if ($position === 'top-right') {
      return `top: 0; right: 0;`
    } else if ($position === 'bottom-right') {
      return `bottom: 0; right: 0;`
    } else if ($position === 'bottom-left') {
      return `bottom: 0; left: 0;`
    }
  }}
  max-width: calc(100% - 10px);
  box-sizing: border-box;

  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 10px;
  margin: 5px;
  font-weight: 600;
  font-size: 20px;
  color: white;
  text-shadow: 0 0 4px black;
  letter-spacing: -0.025em;
  background: ${({ $isListening, $activeColor }) =>
    Color($isListening ? $activeColor : 'black')
      .alpha(0.5)
      .toString()};
  border-radius: 4px;
  backdrop-filter: blur(10px);
  overflow: hidden;

  span {
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }

  svg {
    width: 1.25em;
    height: 1.25em;
    overflow: visible;
    filter: drop-shadow(0 0 4px black);

    &:first-child {
      margin-right: 0.35em;
    }

    &:last-child {
      margin-left: 0.5em;
    }

    path {
      fill: white;
    }
  }
`

const StreamLocation = styled.div`
  position: absolute;
  bottom: 0px;
  left: 0px;
  max-width: calc(100% - 18px);

  display: flex;
  align-items: center;
  gap: 3px;
  margin: 5px 9px;
  font-weight: 800;
  font-size: 14px;
  color: white;
  letter-spacing: -0.025em;
  opacity: 0.9;
  filter: drop-shadow(0 0 4px black);

  span {
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }

  svg {
    flex-shrink: 0;
  }
`

const LoadingSpinner = styled(TailSpin)<{ $isVisible: boolean }>`
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 100px;
  height: 100px;
  opacity: ${({ $isVisible }) => ($isVisible ? 0.5 : 0)};

  transition:
    opacity 0.5s ease-in-out,
    visibility 0s ${({ $isVisible }) => ($isVisible ? '0s' : '0.5s')};
  visibility: ${({ $isVisible }) => ($isVisible ? 'visible' : 'hidden')};
`

const FilterCover = styled.div<{
  $isBlurred: boolean
  $isDesaturated: boolean
}>`
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  backdrop-filter: ${({ $isBlurred, $isDesaturated }) =>
    [
      $isBlurred ? 'blur(30px)' : '',
      $isDesaturated ? 'grayscale(75%)' : '',
    ].join(' ')};
`

const ErrorCover = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  box-sizing: border-box;
  text-align: center;
  color: white;
  background: ${Color('#300').alpha(0.55).toString()};
  backdrop-filter: blur(4px) grayscale(80%);
`

const ErrorIcon = styled.div`
  display: flex;
  color: #ff5a5a;
  filter: drop-shadow(0 0 6px black);

  svg {
    width: 44px;
    height: 44px;
  }
`

const ErrorHeading = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  max-width: 100%;
  font-weight: 700;
  font-size: 22px;
  letter-spacing: -0.025em;
  text-shadow: 0 0 4px black;

  span {
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }

  svg {
    width: 1.1em;
    height: 1.1em;
    flex-shrink: 0;
    filter: drop-shadow(0 0 4px black);

    path {
      fill: white;
    }
  }
`

const ErrorReason = styled.div`
  max-width: 100%;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.3;
  opacity: 0.9;
  text-shadow: 0 0 4px black;
  overflow-wrap: anywhere;

  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
`
