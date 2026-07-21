#!/usr/bin/env node
// Fails when a *direct* dependency of the workspace root or of any workspace
// carries a `deprecated` field on the npm registry (#494). `npm ci` prints
// those notices, but they scroll past in the install log without failing or
// annotating anything — which is why `dank-twitch-irc` stayed abandoned for a
// long time before it was noticed by chance (#406).
//
// Only direct dependencies are inspected: transitive deprecations are frequent
// and rarely actionable from here, so including them would make the check
// noisy enough to be ignored.
//
// The dependency list comes from the manifests plus package-lock.json rather
// than from `npm ls`. Both are committed, so the check needs no install, and
// `npm ls` would additionally report the *installed* tree — which in a git
// worktree nested inside the main checkout is polluted with extraneous
// packages resolved from the parent's node_modules.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

export const ALLOWLIST_PATH = '.github/deprecated-dependencies-allowlist.json'

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
]

// npm only ever nests a dependency directly under the workspace that pins it,
// so a hoisted install is the single fallback.
function lockfileEntry(lockfile, workspacePath, name) {
  const candidates = workspacePath
    ? [`${workspacePath}/node_modules/${name}`, `node_modules/${name}`]
    : [`node_modules/${name}`]
  for (const candidate of candidates) {
    const entry = lockfile.packages?.[candidate]
    if (entry) {
      return entry
    }
  }
  return undefined
}

export function collectDirectDependencies({ manifests, lockfile }) {
  const byKey = new Map()

  for (const { path: workspacePath, manifest } of manifests) {
    const dependent = workspacePath || '.'
    const declared = DEPENDENCY_FIELDS.flatMap((field) =>
      Object.keys(manifest[field] ?? {}),
    )

    for (const name of declared) {
      const entry = lockfileEntry(lockfile, workspacePath, name)
      if (!entry) {
        throw new Error(
          `${dependent} depends on "${name}", which has no entry in ` +
            'package-lock.json — run `npm install` to sync the lockfile.',
        )
      }
      // A link points at another workspace in this repo: there is no registry
      // entry to ask about.
      if (entry.link) {
        continue
      }

      const key = `${name}@${entry.version}`
      const collected = byKey.get(key)
      if (collected) {
        if (!collected.dependents.includes(dependent)) {
          collected.dependents.push(dependent)
        }
      } else {
        byKey.set(key, {
          name,
          version: entry.version,
          dependents: [dependent],
        })
      }
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
}

export function parseAllowlist(data) {
  if (!Array.isArray(data?.allow)) {
    throw new Error(`${ALLOWLIST_PATH} must contain an "allow" array.`)
  }

  const allowlist = new Map()
  for (const entry of data.allow) {
    for (const field of ['package', 'reason', 'issue']) {
      if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') {
        throw new Error(
          `${ALLOWLIST_PATH}: every entry needs a non-empty "${field}" ` +
            `(offending entry: ${JSON.stringify(entry)}).`,
        )
      }
    }
    if (allowlist.has(entry.package)) {
      throw new Error(`${ALLOWLIST_PATH}: "${entry.package}" is listed twice.`)
    }
    allowlist.set(entry.package, entry)
  }
  return allowlist
}

export async function fetchDeprecations(
  dependencies,
  { concurrency = 8, lookUp = lookUpDeprecation } = {},
) {
  const deprecations = new Map()
  const queue = [...dependencies]

  async function worker() {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        deprecations.set(`${next.name}@${next.version}`, await lookUp(next))
      } catch (error) {
        // Left unset on purpose: a failed lookup is reported as unchecked
        // rather than silently passing as "not deprecated".
        console.warn(
          `Registry lookup for ${next.name}@${next.version} failed: ${error.message}`,
        )
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  )
  return deprecations
}

// `npm view <name>@<exact-version> deprecated --json` prints the deprecation
// message, or nothing at all when the version is current.
async function lookUpDeprecation({ name, version }) {
  const { stdout } = await execFileAsync(
    'npm',
    ['view', `${name}@${version}`, 'deprecated', '--json'],
    { cwd: rootDir },
  )
  const trimmed = stdout.trim()
  return trimmed === '' ? null : JSON.parse(trimmed)
}

export function evaluateDeprecations({
  dependencies,
  deprecations,
  allowlist,
}) {
  const violations = []
  const tolerated = []
  const unchecked = []
  const applied = new Set()

  for (const dependency of dependencies) {
    const key = `${dependency.name}@${dependency.version}`
    if (!deprecations.has(key)) {
      unchecked.push(dependency)
      continue
    }
    const message = deprecations.get(key)
    if (!message) {
      continue
    }

    const allowance = allowlist.get(dependency.name)
    if (allowance) {
      applied.add(dependency.name)
      tolerated.push({ ...dependency, message, allowance })
    } else {
      violations.push({ ...dependency, message })
    }
  }

  const stale = [...allowlist.values()].filter(
    (entry) => !applied.has(entry.package),
  )
  return { violations, tolerated, stale, unchecked }
}

export function formatReport({ violations, tolerated, stale, unchecked }) {
  const lines = []

  for (const { name, version, dependents, message } of violations) {
    lines.push(
      `::error::${name}@${version} is deprecated on npm (required by ` +
        `${dependents.join(', ')}): ${message}`,
    )
  }
  for (const { name, version, allowance } of tolerated) {
    lines.push(
      `::notice::${name}@${version} is deprecated but allowlisted: ` +
        `${allowance.reason} (${allowance.issue})`,
    )
  }
  for (const entry of stale) {
    lines.push(
      `::warning::${ALLOWLIST_PATH} still allows "${entry.package}", which is ` +
        'no longer a deprecated direct dependency — drop the entry.',
    )
  }
  for (const { name, version } of unchecked) {
    lines.push(
      `::error::Could not determine whether ${name}@${version} is deprecated.`,
    )
  }

  lines.push(
    violations.length === 0 && unchecked.length === 0
      ? 'No deprecated direct dependencies.'
      : `${violations.length} deprecated direct ${
          violations.length === 1 ? 'dependency' : 'dependencies'
        }, ${unchecked.length} unchecked.`,
  )
  return lines.join('\n')
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

function readManifests() {
  const root = readJson('package.json')
  return [
    { path: '', manifest: root },
    ...root.workspaces.map((workspace) => ({
      path: workspace,
      manifest: readJson(join(workspace, 'package.json')),
    })),
  ]
}

async function main() {
  const dependencies = collectDirectDependencies({
    manifests: readManifests(),
    lockfile: readJson('package-lock.json'),
  })
  console.log(`Checking ${dependencies.length} direct dependencies…`)

  const result = evaluateDeprecations({
    dependencies,
    deprecations: await fetchDeprecations(dependencies),
    allowlist: parseAllowlist(readJson(ALLOWLIST_PATH)),
  })

  console.log(formatReport(result))
  if (result.violations.length > 0 || result.unchecked.length > 0) {
    process.exitCode = 1
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
