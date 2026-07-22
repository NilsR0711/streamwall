// react-icons renders through preact/compat's Context.Consumer, which currently
// crashes under this package's happy-dom test environment (unrelated to
// anything the ControlUI specs assert on). Every spec that mounts the full
// ControlUI stubs the icon modules out with these, so the component can render
// far enough to be exercised in isolation.
//
// This module deliberately has no imports: the specs pull it in from inside
// their `vi.mock('react-icons/...')` factories, so it must not drag the
// component tree - and with it react-icons itself - into the factory.

export const faIconStubs = {
  FaExchangeAlt: () => null,
  FaExclamationTriangle: () => null,
  FaRedoAlt: () => null,
  FaRegLifeRing: () => null,
  FaRegWindowMaximize: () => null,
  FaSyncAlt: () => null,
  FaVideoSlash: () => null,
  FaVolumeUp: () => null,
}

export const mdIconStubs = {
  MdOutlineStayCurrentLandscape: () => null,
  MdOutlineStayCurrentPortrait: () => null,
}
