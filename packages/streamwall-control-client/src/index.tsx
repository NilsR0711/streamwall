import { render } from 'preact'
import { ControlUI, GlobalStyle } from 'streamwall-control-ui'
import { useStreamwallWebsocketConnection } from './useStreamwallWebsocketConnection.ts'

function App() {
  const { BASE_URL } = import.meta.env

  const connection = useStreamwallWebsocketConnection(
    (BASE_URL === '/' ? `ws://${location.host}` : BASE_URL) + '/client/ws',
  )

  return (
    <>
      <GlobalStyle />
      <ControlUI connection={connection} />
    </>
  )
}

render(<App />, document.body)
