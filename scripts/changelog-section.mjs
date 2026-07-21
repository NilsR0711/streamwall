#!/usr/bin/env node
// Prints the CHANGELOG.md section for one release, so `.github/workflows/
// release.yml` can use it as the GitHub Release body instead of leaving the
// release electron-forge creates without notes. See CONTRIBUTING.md.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Returns the body of the `## [<version>]` section of a changelog, without its
 * heading. Both the manual "Keep a Changelog" headings (`## [0.9.1] - date`)
 * and the ones release-please generates (`## [0.9.2](compare-link) (date)`) are
 * recognised.
 */
export function extractChangelogSection(changelog, version) {
  const heading = new RegExp(
    `^## \\[?${escapeRegExp(version)}\\]?(?![0-9A-Za-z.-])[^\\n]*\\n`,
    'm',
  )
  const match = heading.exec(changelog)
  if (!match) {
    throw new Error(
      `CHANGELOG.md has no section for version ${version}. Releases are cut ` +
        'from the changelog, so the tag and the changelog must agree.',
    )
  }

  const rest = changelog.slice(match.index + match[0].length)
  const nextHeading = /^## /m.exec(rest)
  const section = (nextHeading ? rest.slice(0, nextHeading.index) : rest)
    // Link-reference definitions live at the bottom of the file and would
    // otherwise be appended to the oldest section.
    .replace(/^\[[^\]]+\]:\s*\S+$/gm, '')
    .trim()

  if (!section) {
    throw new Error(
      `The CHANGELOG.md section for version ${version} is empty; a release ` +
        'must describe what changed.',
    )
  }
  return section
}

function main() {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: node scripts/changelog-section.mjs <x.y.z>')
    process.exit(1)
  }
  try {
    const changelog = readFileSync(join(rootDir, 'CHANGELOG.md'), 'utf8')
    process.stdout.write(`${extractChangelogSection(changelog, version)}\n`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
