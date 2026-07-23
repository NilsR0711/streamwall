import { render } from 'preact'
import { ControlUI, GlobalStyle } from 'streamwall-control-ui'
import { useStreamwallWebsocketConnection } from './useStreamwallWebsocketConnection.ts'
import { controlWebSocketEndpoint } from './wsEndpoint.ts'

function App() {
  const { BASE_URL } = import.meta.env

  const connection = useStreamwallWebsocketConnection(
    controlWebSocketEndpoint(BASE_URL, location),
  )

  return (
    <>
      <GlobalStyle />
      <ControlUI connection={connection} />
    </>
  )
}

render(<App />, document.body)
