import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

export function readJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

export function lockfilePackages() {
  return readJson('package-lock.json').packages
}

/**
 * Where a package installed at `location` (a package-lock.json key such as
 * `packages/streamwall-control-server/node_modules/@fastify/static`) resolves
 * `name` from, or `null` if nothing above it provides the package.
 *
 * npm is free to move an install between the root and a workspace whenever a
 * version changes, so tests should assert that a resolution *succeeds* rather
 * than that a package sits in one particular directory. This mirrors Node's
 * upward `node_modules` walk over the lockfile's flat key space.
 */
export function resolvesFrom(packages, location, name) {
  let dir = location

  for (;;) {
    const candidate =
      dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`

    const entry = packages[candidate]
    // An optional peer is one npm may drop on the next regeneration, so it
    // does not count as a dependable resolution.
    if (entry && !(entry.optional && entry.peer)) {
      return candidate
    }

    if (dir === '') {
      return null
    }

    const nesting = dir.lastIndexOf('/node_modules/')
    dir = nesting === -1 ? '' : dir.slice(0, nesting)
  }
}
