import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { initApp } from './index.ts'
import { loadStorage, type StorageDB } from './storage.ts'

export interface TestApp {
  app: FastifyInstance
  db: StorageDB
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
  const { app } = await initApp({ baseURL, clientStaticPath: staticDir, db })

  const cleanup = async () => {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }

  return { app, db, baseURL, cleanup }
}
