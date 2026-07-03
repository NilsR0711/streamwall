import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const rendererDir = fileURLToPath(new URL('.', import.meta.url))

for (const file of ['overlay.tsx', 'background.tsx']) {
  const source = readFileSync(`${rendererDir}${file}`, 'utf8')

  test(`${file} does not hardcode the ineffective allow-same-origin sandbox`, () => {
    assert.doesNotMatch(source, /allow-same-origin/)
  })

  test(`${file} applies the shared LAYER_FRAME_SANDBOX policy to its iframe`, () => {
    assert.match(source, /sandbox=\{LAYER_FRAME_SANDBOX\}/)
  })
}
