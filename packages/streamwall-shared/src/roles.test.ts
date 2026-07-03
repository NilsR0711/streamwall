import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { roleCan } from './roles.ts'

describe('roleCan', () => {
  describe('interact-view', () => {
    test('is allowed for local, admin and operator', () => {
      assert.equal(roleCan('local', 'interact-view'), true)
      assert.equal(roleCan('admin', 'interact-view'), true)
      assert.equal(roleCan('operator', 'interact-view'), true)
    })

    test('is denied for monitor', () => {
      assert.equal(roleCan('monitor', 'interact-view'), false)
    })

    test('is denied for a null role', () => {
      assert.equal(roleCan(null, 'interact-view'), false)
    })
  })

  describe('regression: existing permissions are unchanged', () => {
    test('keeps reload-view as an operator action', () => {
      assert.equal(roleCan('operator', 'reload-view'), true)
      assert.equal(roleCan('monitor', 'reload-view'), false)
    })

    test('keeps browse as an admin-only action', () => {
      assert.equal(roleCan('admin', 'browse'), true)
      assert.equal(roleCan('operator', 'browse'), false)
      assert.equal(roleCan('monitor', 'browse'), false)
    })

    test('keeps monitor limited to blur and censor', () => {
      assert.equal(roleCan('monitor', 'set-view-blurred'), true)
      assert.equal(roleCan('monitor', 'set-stream-censored'), true)
      assert.equal(roleCan('monitor', 'set-listening-view'), false)
    })
  })
})
