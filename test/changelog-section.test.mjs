import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractChangelogSection } from '../scripts/changelog-section.mjs'

const RELEASE_PLEASE_CHANGELOG = `# Changelog

Preamble that must never leak into release notes.

## [0.9.2](https://github.com/NilsR0711/streamwall/compare/v0.9.1...v0.9.2) (2026-07-30)

### Features

* **control-ui:** show the server version ([#444](https://github.com/NilsR0711/streamwall/issues/444))

### Bug Fixes

* **streamwall:** disconnect observers on teardown ([#412](https://github.com/NilsR0711/streamwall/issues/412))

## [0.9.1] - 2026-07-15

### Fixed

- The control server defaults its listen port when the URL has no port (#378).

## [0.9.0] - 2026-07-15

Initial public release.

[0.9.1]: https://github.com/NilsR0711/streamwall/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/NilsR0711/streamwall/releases/tag/v0.9.0
`

test('extracts a release-please section without its heading', () => {
  const section = extractChangelogSection(RELEASE_PLEASE_CHANGELOG, '0.9.2')

  assert.match(section, /^### Features/)
  assert.match(section, /disconnect observers on teardown/)
  assert.doesNotMatch(section, /^## /m)
  assert.doesNotMatch(section, /Preamble/)
})

test('stops at the next release heading', () => {
  const section = extractChangelogSection(RELEASE_PLEASE_CHANGELOG, '0.9.1')

  assert.match(section, /defaults its listen port/)
  assert.doesNotMatch(section, /Initial public release/)
})

test('drops the trailing compare-link definitions', () => {
  const section = extractChangelogSection(RELEASE_PLEASE_CHANGELOG, '0.9.0')

  assert.equal(section, 'Initial public release.')
})

test('rejects a version that has no changelog section', () => {
  assert.throws(
    () => extractChangelogSection(RELEASE_PLEASE_CHANGELOG, '1.0.0'),
    /no section for version 1\.0\.0/,
  )
})

test('rejects a version whose section is empty', () => {
  const changelog =
    '# Changelog\n\n## [1.0.0] - 2026-07-30\n\n## [0.9.0]\n\nx\n'

  assert.throws(
    () => extractChangelogSection(changelog, '1.0.0'),
    /section for version 1\.0\.0 is empty/,
  )
})

// A version like "0.9" must not match the "0.9.2" heading, and regex
// metacharacters in the argument must not be interpreted.
test('matches the version heading literally', () => {
  assert.throws(
    () => extractChangelogSection(RELEASE_PLEASE_CHANGELOG, '0.9'),
    /no section for version 0\.9/,
  )
  assert.throws(
    () => extractChangelogSection(RELEASE_PLEASE_CHANGELOG, '0.9.\\d'),
    /no section for version/,
  )
})

test('accepts a heading without brackets', () => {
  const changelog = '# Changelog\n\n## 1.0.0 (2026-07-30)\n\nShipped it.\n'

  assert.equal(extractChangelogSection(changelog, '1.0.0'), 'Shipped it.')
})
