import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import exampleConfigToml from '../../../../example.config.toml?raw'
import { createExampleConfig } from './exampleConfig'

let dir: string | undefined

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('createExampleConfig', () => {
  it('writes the bundled example.config.toml verbatim to the given path', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sw-example-config-'))
    const configPath = path.join(dir, 'config.toml')

    createExampleConfig(configPath)

    expect(readFileSync(configPath, 'utf-8')).toBe(exampleConfigToml)
  })

  it('fails loud instead of overwriting a file that already exists at that path', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sw-example-config-'))
    const configPath = path.join(dir, 'config.toml')
    writeFileSync(configPath, 'existing user config')

    expect(() => createExampleConfig(configPath)).toThrow()

    expect(readFileSync(configPath, 'utf-8')).toBe('existing user config')
  })
})
