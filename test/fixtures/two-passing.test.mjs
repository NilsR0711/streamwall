// Fixture for test/run-tests.test.mjs: a suite with a known number of tests,
// used to verify that scripts/run-tests.mjs really gets a test count out of a
// live `node --test` run. It lives in `fixtures/` so the root leg's
// `test/*.test.mjs` glob does not pick it up as a repository invariant test.
import { test } from 'node:test'

test('first', () => {})
test('second', () => {})
