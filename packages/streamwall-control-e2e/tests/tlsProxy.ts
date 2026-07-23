import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Generates a throwaway self-signed certificate for the TLS proxy. The
 * `openssl` binary is available on the Linux CI runners and on macOS
 * (LibreSSL). The TLS spec runs Playwright with `ignoreHTTPSErrors`, so the
 * certificate only has to exist — it is never validated by the browser.
 */
async function generateSelfSignedCert(): Promise<{
  key: string
  cert: string
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'streamwall-e2e-tls-'))
  try {
    const keyPath = path.join(dir, 'key.pem')
    const certPath = path.join(dir, 'cert.pem')
    await execFileAsync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=streamwall-e2e',
    ])
    const [key, cert] = await Promise.all([
      readFile(keyPath, 'utf8'),
      readFile(certPath, 'utf8'),
    ])
    return { key, cert }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A running TLS terminator in front of a plain-HTTP control server. */
export interface TlsProxy {
  /** Port the browser connects to over `https://` / `wss://`. */
  readonly port: number
  close(): Promise<void>
}

/**
 * Starts a raw TLS terminator in front of `backendPort`: every decrypted byte
 * stream is piped verbatim into a plain TCP connection against the control
 * server, so HTTP requests and WebSocket upgrades both pass through untouched
 * — the same shape as the reverse proxy (Caddy, nginx, ...) in the documented
 * self-hosting setup.
 */
export async function startTlsProxy(backendPort: number): Promise<TlsProxy> {
  const { key, cert } = await generateSelfSignedCert()
  const sockets = new Set<tls.TLSSocket>()

  const server = tls.createServer({ key, cert }, (clientSocket) => {
    const backend = net.connect(backendPort, '127.0.0.1')
    sockets.add(clientSocket)
    // Either side dropping (browser tab teardown, server close) tears down the
    // pair; without the error handlers a routine ECONNRESET would crash the
    // test process.
    const teardown = () => {
      sockets.delete(clientSocket)
      clientSocket.destroy()
      backend.destroy()
    }
    clientSocket.on('error', teardown)
    clientSocket.on('close', teardown)
    backend.on('error', teardown)
    backend.on('close', teardown)
    clientSocket.pipe(backend)
    backend.pipe(clientSocket)
  })
  // A client aborting mid-handshake surfaces here, not on a connection socket.
  server.on('tlsClientError', () => {})

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port

  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy()
      }
      server.close(() => resolve())
    })

  return { port, close }
}
