import { Low, Memory } from 'lowdb'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type AppOptions, initApp } from './index.ts'
import type { StoredData } from './storage.ts'

/**
 * Creates a throwaway directory containing a minimal index.html so that
 * `@fastify/static` can be registered against a valid root during tests.
 */
export function makeStaticDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-static-'))
  writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><title>streamwall test</title>',
  )
  return dir
}

/** An isolated in-memory storage backend, so tests never touch the disk. */
export function inMemoryDb(): Low<StoredData> {
  return new Low<StoredData>(new Memory<StoredData>(), {
    auth: { salt: null, tokens: [] },
    streamwallToken: null,
  })
}

/**
 * Builds a fully-wired app instance backed by in-memory storage and throwaway
 * static assets, ready for `app.inject()` or `app.listen()` in tests.
 */
export function buildTestApp(overrides: Partial<AppOptions> = {}) {
  return initApp({
    baseURL: 'http://localhost:3000',
    clientStaticPath: makeStaticDir(),
    db: inMemoryDb(),
    ...overrides,
  })
}
