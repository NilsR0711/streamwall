import type { FastifyInstance } from 'fastify'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Auth } from './auth.ts'
import { initApp } from './index.ts'
import { loadStorage, type StorageDB } from './storage.ts'

export interface TestApp {
  app: FastifyInstance
  db: StorageDB
  auth: Auth
  baseURL: string
  cleanup: () => Promise<void>
}

/**
 * Build an isolated control-server app backed by a throwaway temp-file database
 * and a temp static directory. Never listens on a port; use `app.inject()` for
 * HTTP and `app.listen({ port: 0 })` for WebSocket tests.
 */
export async function createTestApp(
  opts: { baseURL?: string } = {},
): Promise<TestApp> {
  const dir = mkdtempSync(path.join(tmpdir(), 'swcs-test-'))
  const dbPath = path.join(dir, 'storage.json')
  const staticDir = path.join(dir, 'static')
  mkdirSync(staticDir)
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html>\n')

  const db = await loadStorage(dbPath)
  const baseURL = opts.baseURL ?? 'http://localhost:3000'
  const { app, auth } = await initApp({
    baseURL,
    clientStaticPath: staticDir,
    db,
  })

  // lowdb writes atomically via a sibling temp file; while it exists a write is
  // in flight. Auth-state changes persist through fire-and-forget writes, so
  // wait for them to drain before removing the dir to avoid a deletion race.
  const tmpFile = path.join(
    path.dirname(dbPath),
    `.${path.basename(dbPath)}.tmp`,
  )
  const cleanup = async () => {
    await app.close()
    for (let i = 0; i < 100 && existsSync(tmpFile); i++) {
      await delay(5)
    }
    rmSync(dir, { recursive: true, force: true })
  }

  return { app, db, auth, baseURL, cleanup }
}
