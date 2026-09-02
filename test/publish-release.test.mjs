import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeOutcome } from '../scripts/publish-release.mjs'

test('describeOutcome publishes a release with no missing artifact kinds', () => {
  const outcome = describeOutcome({ tag: 'v0.10.6', missing: [] })

  assert.equal(outcome.shouldPublish, true)
  assert.match(outcome.message, /v0\.10\.6/)
  assert.doesNotMatch(outcome.message, /::error::/)
})

// A leg that reported success but somehow left nothing behind, or an upload
// that never finished, must keep the release a draft rather than publish a
// half-built one — the exact failure mode #698 exists to prevent.
test('describeOutcome refuses to publish when an artifact kind is missing', () => {
  const outcome = describeOutcome({
    tag: 'v0.10.6',
    missing: ['*-setup-*.exe', 'latest.yml'],
  })

  assert.equal(outcome.shouldPublish, false)
  assert.match(outcome.message, /^::error::/)
  assert.match(outcome.message, /\*-setup-\*\.exe/)
  assert.match(outcome.message, /latest\.yml/)
  // Still points at the manual fallback so the maintainer is not stuck.
  assert.match(outcome.message, /gh release edit v0\.10\.6 --draft=false/)
})
