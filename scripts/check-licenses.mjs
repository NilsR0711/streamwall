#!/usr/bin/env node
// Fails when a production dependency ships under a license that is not
// compatible with redistributing it inside the MIT-licensed release binaries.
// The policy this enforces is documented in CONTRIBUTING.md ("Allowed
// dependency licenses"); test/licenses.test.mjs keeps the two in sync.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Permissive licenses only: everything here allows redistribution in a
// closed or differently-licensed bundle as long as the notice is kept.
// Copyleft (GPL/AGPL/LGPL/MPL) is deliberately absent — adding one is a
// project decision, not a mechanical allowlist edit.
export const ALLOWED_LICENSES = [
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'OFL-1.1',
  'Python-2.0',
  'Unlicense',
]

const ALLOWED_LOOKUP = new Set(
  ALLOWED_LICENSES.map((license) => license.toLowerCase()),
)

// SPDX identifiers are case-insensitive; the `AND`/`OR` operators are not.
// `WITH` is not handled on purpose: an exception rewrites the terms of the
// license it attaches to, so it needs a human decision.
function tokenize(expression) {
  return expression
    .replace(/([()])/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean)
}

function parseExpression(tokens, position) {
  let result = parseConjunction(tokens, position)
  while (result && tokens[result.position] === 'OR') {
    const right = parseConjunction(tokens, result.position + 1)
    if (!right) {
      return null
    }
    result = {
      allowed: result.allowed || right.allowed,
      position: right.position,
    }
  }
  return result
}

function parseConjunction(tokens, position) {
  let result = parseTerm(tokens, position)
  while (result && tokens[result.position] === 'AND') {
    const right = parseTerm(tokens, result.position + 1)
    if (!right) {
      return null
    }
    result = {
      allowed: result.allowed && right.allowed,
      position: right.position,
    }
  }
  return result
}

function parseTerm(tokens, position) {
  const token = tokens[position]
  if (token === undefined || token === ')') {
    return null
  }
  if (token === '(') {
    const inner = parseExpression(tokens, position + 1)
    if (!inner || tokens[inner.position] !== ')') {
      return null
    }
    return { allowed: inner.allowed, position: inner.position + 1 }
  }
  if (token === 'AND' || token === 'OR' || token === 'WITH') {
    return null
  }
  return {
    allowed: ALLOWED_LOOKUP.has(token.toLowerCase()),
    position: position + 1,
  }
}

export function isLicenseAllowed(license) {
  if (typeof license !== 'string' || license.trim() === '') {
    return false
  }
  const tokens = tokenize(license)
  const parsed = parseExpression(tokens, 0)
  return Boolean(parsed && parsed.position === tokens.length && parsed.allowed)
}

// npm reports whatever the package manifest declares. Modern packages use the
// SPDX `license` string; older ones use `{ type }` objects or a `licenses`
// array. Anything else stays `null` so it surfaces as a violation instead of
// passing unnoticed.
function normalizeLicense(node) {
  if (typeof node.license === 'string') {
    return node.license
  }
  if (node.license && typeof node.license.type === 'string') {
    return node.license.type
  }
  if (Array.isArray(node.licenses)) {
    const types = node.licenses
      .map((entry) =>
        typeof entry === 'string' ? entry : (entry?.type ?? null),
      )
      .filter((type) => typeof type === 'string')
    if (types.length === 1) {
      return types[0]
    }
    if (types.length > 1) {
      return `(${types.join(' OR ')})`
    }
  }
  return null
}

// Reads the installed manifest a tree node points at. `npm ls --long` only
// expands the manifest fields on some occurrences of a package — a second,
// deduplicated occurrence can carry nothing but a version and a path — so the
// manifest on disk is the authoritative source and the node is the fallback.
export function readPackageManifest(path) {
  try {
    return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

// Flattens `npm ls --omit=dev --all --long --json` into one entry per
// installed package. Nodes without a `path` are unmet optional or peer
// dependencies that npm lists but never installed, and extraneous nodes are
// leftovers from an earlier install — neither reaches a packaged release.
export function collectProductionPackages(
  tree,
  readManifest = readPackageManifest,
) {
  const packages = new Map()

  const walk = (node) => {
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      const key = `${name}@${dependency.version}`
      if (packages.has(key)) {
        continue
      }
      if (!dependency.path || dependency.extraneous) {
        continue
      }
      packages.set(key, {
        name,
        version: dependency.version,
        license: normalizeLicense({
          ...dependency,
          ...(readManifest(dependency.path) ?? {}),
        }),
      })
      walk(dependency)
    }
  }

  walk(tree)
  return [...packages.values()]
}

export function findLicenseViolations(packages) {
  return packages.filter(({ license }) => !isLicenseAllowed(license))
}

export function formatViolations(violations) {
  return violations
    .map(
      ({ name, version, license }) =>
        `  ${name}@${version}: ${license ?? 'no license field'}`,
    )
    .join('\n')
}

function readProductionTree() {
  // `npm ls` exits non-zero whenever the tree has any problem (an unmet
  // optional dependency is enough), so the exit code is not a useful signal
  // here — the JSON on stdout is.
  const output = execFileSync(
    'npm',
    ['ls', '--omit=dev', '--all', '--long', '--json'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  return JSON.parse(output)
}

function main() {
  let tree
  try {
    tree = readProductionTree()
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim() !== '') {
      tree = JSON.parse(error.stdout)
    } else {
      console.error(
        `Could not read the production dependency tree: ${error.message}`,
      )
      process.exit(1)
    }
  }

  const packages = collectProductionPackages(tree)
  const violations = findLicenseViolations(packages)

  if (violations.length > 0) {
    console.error(
      `${violations.length} of ${packages.length} production dependencies are not covered by the license allowlist:\n` +
        `${formatViolations(violations)}\n\n` +
        `Allowed: ${ALLOWED_LICENSES.join(', ')}.\n` +
        'See the "Allowed dependency licenses" section in CONTRIBUTING.md.',
    )
    process.exit(1)
  }

  console.log(
    `All ${packages.length} production dependencies are covered by the license allowlist.`,
  )
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
