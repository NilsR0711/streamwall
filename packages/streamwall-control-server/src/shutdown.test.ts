import assert from 'node:assert/strict'
import net from 'node:net'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { buildTestApp, listenTestApp } from './testHelpers.ts'

/**
 * `app.close()` must not block on connections that are still mid-request.
 *
 * Node's `server.close()` reaps *idle* keep-alive sockets once, at the moment
 * it is called; a socket that is busy right then keeps the server open until
 * its peer hangs up or `keepAliveTimeout` (72s) expires. A real browser tab
 * always has requests in flight, so shutting the server down underneath one is
 * the normal case, not an edge case.
 *
 * Fastify's default `forceCloseConnections: 'idle'` does not cover this: that
 * branch only reaches `server.closeIdleConnections()` for apps built with a
 * custom `serverFactory`, which we do not use. Up to fastify 5.11 the default
 * still hit `closeAllConnections()` by accident (the check was for
 * truthiness, and `'idle'` is truthy); 5.12 tightened it to `=== true`, so the
 * app stopped closing connections at shutdown entirely — which is what made
 * the control-client e2e suite fail with `Tearing down "harness" exceeded the
 * test timeout`. We therefore ask for `forceCloseConnections: true`
 * explicitly instead of relying on a default that has drifted twice.
 */
test('close() does not wait for a connection that is still mid-request', async () => {
  const { app } = await buildTestApp()
  const port = await listenTestApp(app)

  // A half-sent request: the server has accepted the socket and is waiting for
  // the rest of the headers, so Node counts it as busy rather than idle — the
  // assertion below is what proves that, since an idle socket would already be
  // reaped by the sweep inside `server.close()` and the test could not fail.
  const socket = net.connect(port, '127.0.0.1')
  after(() => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
      resolve()
    })
  })
  await delay(100)

  // Raced rather than awaited: a regression here does not fail, it blocks for
  // a minute, which would stall the whole suite instead of reporting.
  const outcome = await Promise.race([
    app.close().then(() => 'closed' as const),
    delay(5000).then(() => 'still draining' as const),
  ])

  assert.equal(
    outcome,
    'closed',
    'app.close() must force lingering connections shut instead of draining them',
  )
})
