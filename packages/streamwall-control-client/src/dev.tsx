/**
 * Dev harness for iterating on the control UI design in the browser with HMR.
 *
 * It renders the real <ControlUI> against a *mock* connection backed by static
 * demo data instead of a live WebSocket — so no control-server, app process or
 * login is required. The design lives in the shared `streamwall-control-ui`
 * package, so anything tweaked here shows up in the real Electron + browser apps.
 *
 * Run with: npx vite --config vite.config.ts  (open /dev.html)
 */
import { render } from 'preact'
import { useEffect } from 'preact/hooks'
import {
  type CollabData,
  ControlUI,
  GlobalStyle,
  type StreamwallConnection,
  useStreamwallState,
  useYDoc,
} from 'streamwall-control-ui'
import { type StreamData, type StreamwallState } from 'streamwall-shared'
import * as Y from 'yjs'

const s = (
  o: Partial<StreamData> & { _id: string; link: string },
): StreamData => ({
  _dataSource: 'demo',
  kind: 'video',
  ...o,
})

const demoStreams: StreamData[] = [
  s({
    _id: 'wok',
    link: 'https://twitch.tv/woke',
    label: 'PDX Live',
    city: 'Portland',
    state: 'OR',
    source: 'woke.net',
    status: 'Live',
  }),
  s({
    _id: 'oma',
    link: 'https://youtube.com/watch?v=oma',
    label: 'Capitol Hill',
    city: 'Seattle',
    state: 'WA',
    source: 'Omari Salisbury',
    status: 'Live',
  }),
  s({
    _id: 'uni',
    link: 'https://facebook.com/unicornriot/v/1',
    label: 'South MPLS',
    city: 'Minneapolis',
    state: 'MN',
    source: 'Unicorn Riot',
    status: 'Live',
  }),
  s({
    _id: 'dcw',
    link: 'https://twitch.tv/dcprotest',
    label: 'Capitol',
    city: 'Washington',
    state: 'DC',
    source: 'DC Watch',
    status: 'Live',
  }),
  s({
    _id: 'chi',
    link: 'https://kick.com/chicago',
    label: 'The Loop',
    city: 'Chicago',
    state: 'IL',
    source: 'CHI Stream',
    status: 'Live',
  }),
  s({
    _id: 'zom',
    link: 'https://html5zombo.com',
    label: 'Zombo',
    source: 'zombo.com',
    kind: 'web',
  }),
  s({
    _id: 'nyc',
    link: 'https://twitch.tv/nyclive',
    label: 'Manhattan',
    city: 'New York',
    state: 'NY',
    source: 'NYC Live',
  }),
  s({
    _id: 'lad',
    link: 'https://youtube.com/watch?v=lad',
    label: 'DTLA',
    city: 'Los Angeles',
    state: 'CA',
    source: 'LA Direct',
  }),
  s({
    _id: 'oak',
    link: 'https://youtube.com/watch?v=oak',
    label: 'Bay Bridge',
    city: 'Oakland',
    state: 'CA',
    source: 'Oakland Now',
  }),
]

// Which stream sits in which grid cell (drives the wall preview + inputs).
const placement: Record<string, string | undefined> = {
  '0': 'wok',
  '1': 'oma',
  '2': 'uni',
  '3': 'nyc',
  '4': 'dcw',
  '5': undefined,
  '6': 'lad',
  '7': undefined,
  '8': undefined,
}

// Synthesize "running" views so the grid preview shows the placed streams.
const GRID = { cols: 3, rows: 3, width: 1920, height: 1080 }
const SPACE_W = GRID.width / GRID.cols
const SPACE_H = GRID.height / GRID.rows
const demoViews = Object.entries(placement)
  .filter(([, sid]) => sid != null)
  .map(([idxStr, sid]) => {
    const idx = Number(idxStr)
    const stream = demoStreams.find((d) => d._id === sid)
    return {
      state: { displaying: 'running' },
      context: {
        id: idx + 1,
        content: { url: stream?.link ?? '', kind: stream?.kind ?? 'video' },
        info: { title: stream?.label ?? '' },
        pos: {
          x: (idx % GRID.cols) * SPACE_W,
          y: Math.floor(idx / GRID.cols) * SPACE_H,
          width: SPACE_W,
          height: SPACE_H,
          spaces: [idx],
        },
      },
    }
  })

const demoState: StreamwallState = {
  identity: { role: 'admin' },
  auth: { invites: [], sessions: [] },
  config: {
    cols: GRID.cols,
    rows: GRID.rows,
    width: GRID.width,
    height: GRID.height,
    frameless: false,
    activeColor: '#f24d2e',
    backgroundColor: '#000000',
  },
  streams: demoStreams,
  customStreams: [],
  views: demoViews as unknown as StreamwallState['views'],
  streamdelay: null,
}

function useMockConnection(): StreamwallConnection {
  const { docValue: sharedState, doc: stateDoc } = useYDoc<CollabData>([
    'views',
  ])
  const appState = useStreamwallState(demoState)

  useEffect(() => {
    const views = stateDoc.getMap<Y.Map<string | undefined>>('views')
    if (views.size > 0) {
      return
    }
    stateDoc.transact(() => {
      for (const [idx, streamId] of Object.entries(placement)) {
        const m = new Y.Map<string | undefined>()
        m.set('streamId', streamId)
        views.set(idx, m)
      }
    })
  }, [stateDoc])

  return {
    ...appState,
    isConnected: true,
    send: (msg) => console.debug('[mock send]', msg),
    sharedState,
    stateDoc,
  }
}

function App() {
  const connection = useMockConnection()
  return (
    <>
      <GlobalStyle />
      <ControlUI connection={connection} />
    </>
  )
}

// Allow forcing a theme via ?theme= for screenshots; the real ThemeToggle
// (in ControlUI) picks this up from localStorage on mount.
const urlTheme = new URLSearchParams(location.search).get('theme')
if (urlTheme) {
  try {
    localStorage.setItem('streamwall:theme', urlTheme)
  } catch {
    // ignore
  }
}

render(<App />, document.body)
