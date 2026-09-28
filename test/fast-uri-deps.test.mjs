import assert from 'node:assert/strict'
import { test } from 'node:test'

import { lockfilePackages } from './lockfileResolution.mjs'

// `fast-uri` is transitive only: nothing in this repo imports it, it arrives
// through Fastify's schema stack (`ajv`, `fast-json-stringify`,
// `@fastify/ajv-compiler`, `ajv-formats`) and, in dev, through electron-forge's
// `schema-utils`/`app-builder-lib`. That is exactly what makes it easy to lose.
//
// #503 fixed GHSA-4c8g-83qw-93j6 (IDN host canonicalization) by bumping the
// hoisted copy to 3.1.4. A later Dependabot lockfile regeneration moved 3.1.4
// up to 3.1.6 within the same `^3` range, so the fix vanished with no
// `package.json` change and no failing test. Further advisories on the same
// package (Dependabot alert security/dependabot/48) then had to be fixed from
// 3.1.6, which is the failure mode this guard exists to close: an in-range bump
// is invisible to review and unrecoverable once it has happened.
//
// The floors are the releases that close every known advisory on each line, not
// the first release that closed any one of them. Upstream shipped two rounds.
// 3.1.7/4.1.4 (and 2.4.6) fixed GHSA-58mr-gqgx-xq4g, host confusion via an
// unbalanced or misplaced IP-literal bracket, and GHSA-qw65-cvwx-89v3, authority
// injection via an unvalidated port in `serialize()` - both high. 3.1.8/4.1.5
// (and 2.4.7) then fixed GHSA-hrr3-gc8f-f4qj, a reg-name whose
// percent-encoded octets escaped case folding, medium. A floor pinned to
// 3.1.7/4.1.4 would still ship the second round's bug while looking like "the
// patched version", so the floor has to be the later release.
//
// Asserting the floor rather than the exact version is deliberate - it keeps the
// guard true as later patches land, and only fires when a copy drops back to a
// version with a known advisory.
const PATCHED_FLOORS = [
  { major: 2, floor: '2.4.7' },
  { major: 3, floor: '3.1.8' },
  { major: 4, floor: '4.1.5' },
]

// Compares two dotted numeric versions component-wise. It has no notion of
// prerelease ordering: `Number('4-rc')` is `NaN`, the first differing component
// becomes `NaN`, and `Math.sign(NaN)` is `NaN`, which is false for `=== 0`,
// `< 0` and `>= 0` alike. The guard asserts `>= 0`, so a version it cannot
// order is treated as below the floor and rejected - `3.1.8-rc.1` fails the
// guard. That is the safe direction, but it is a consequence of `NaN`
// semantics, not of a prerelease rule implemented here. Left as-is on purpose:
// teaching it real prerelease ordering would only make `3.1.8-rc.1` sort
// explicitly below `3.1.8`, which rejects the same inputs with more code.
function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) {
      return Math.sign(diff)
    }
  }

  return 0
}

function installedCopies(packages) {
  return Object.entries(packages)
    .filter(([location]) => location.endsWith('node_modules/fast-uri'))
    .map(([location, { version }]) => ({ location, version }))
    .sort((a, b) => a.location.localeCompare(b.location))
}

// An unbalanced authority bracket is accepted as a host: `[@127.0.0.1` is
// neither validated as an IP literal nor canonicalized, so `parse()` returns it
// with `error` undefined while Node's `URL` resolves the same string to
// 127.0.0.1. An application that reads `parse().host` for a security decision
// and hands the original URL to an HTTP client then evaluates policy against a
// different string than the one reached, through `normalize()`, `equal()` and
// `resolve()` as well.
//
// Reproduced against the patched releases themselves: 3.1.6 and 4.1.3 both
// return `error: undefined` for `http://[127.0.0.1/`, and 3.1.7, 3.1.8, 4.1.4
// and 4.1.5 all return `URI host is malformed.` This bracket case is fixed from
// 3.1.7/4.1.4 onwards, so it is not what sets the floors above - the later
// GHSA-hrr3-gc8f-f4qj round is.
test('every installed fast-uri copy is at or above its patched floor', () => {
  const copies = installedCopies(lockfilePackages())

  assert.ok(
    copies.length > 0,
    'package-lock.json installs no fast-uri at all. The package is only ' +
      'reached transitively, so a tree that no longer installs it means one of ' +
      'the dependents changed rather than that the vulnerability is gone - ' +
      'drop this guard together with that dependency change.',
  )

  for (const { location, version } of copies) {
    const { floor } = PATCHED_FLOORS.find(
      ({ major }) => version.split('.')[0] === String(major),
    ) ?? { floor: null }

    assert.ok(
      floor !== null,
      `${location} installs fast-uri@${version}, a major line this guard ` +
        'knows nothing about. Add it to PATCHED_FLOORS once you have checked ' +
        'which release closes every advisory known on that line.',
    )

    assert.ok(
      compareVersions(version, floor) >= 0,
      `${location} installs fast-uri@${version}, which is below the floor that ` +
        'closes every known advisory on this major line: ' +
        'GHSA-58mr-gqgx-xq4g (host confusion via an unbalanced IP-literal ' +
        'bracket) and GHSA-qw65-cvwx-89v3 (authority injection via an ' +
        'unvalidated port in serialize()), both high and both fixed in the ' +
        '3.1.7/4.1.4 round, plus GHSA-hrr3-gc8f-f4qj (inconsistent host case ' +
        'normalization via percent-encoded octets), medium, which needed the ' +
        `later 3.1.8/4.1.5 round. ${floor} is the first release on this major ` +
        'line that closes all of them; a copy at the earlier round is still ' +
        'vulnerable to the last one. Every dependent declares a range that ' +
        'already admits it, so the fix is a lockfile bump - run ' +
        '`npm install fast-uri@<version> --save-exact=false` inside the ' +
        'dependent, or re-run `npm install` after pinning, and commit the ' +
        'lockfile. Note that an in-range bump alone will not be caught by ' +
        'review, which is how the #503 fix was silently lost (Dependabot ' +
        'alert security/dependabot/48).',
    )
  }
})

// Without this the guard is a no-op in the one situation it exists for: a
// lockfile regeneration that drops fast-uri out of the tree entirely would
// make the loop above iterate zero times and pass.
test('the fast-uri guard sees every copy the tree actually installs', () => {
  const fromLockfile = installedCopies(lockfilePackages())

  assert.ok(
    fromLockfile.length >= 2,
    `the lockfile installs ${fromLockfile.length} copy/copies of fast-uri; ` +
      "the hoisted ^3 copy and the one nested under fastify's " +
      'fast-json-stringify@7 (^4) are both expected. If a copy disappeared, ' +
      'the loop above is checking less than it was written to check.',
  )
})
