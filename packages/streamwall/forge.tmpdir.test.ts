import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createPackagingTmpdir,
  PACKAGING_TMPDIR_PREFIX,
  removePackagingTmpdir,
} from './forge.tmpdir'

const created: string[] = []

function create(): string {
  const dir = createPackagingTmpdir()
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    removePackagingTmpdir(dir)
  }
})

describe('createPackagingTmpdir', () => {
  it('creates an empty directory inside the system temp directory', () => {
    const dir = create()

    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dir)).toEqual([])
    expect(path.dirname(dir)).toBe(os.tmpdir())
  })

  it('gives every packaging run its own directory', () => {
    // The whole point of #510: @electron/packager wipes its base temp
    // directory when a run starts, so two runs must never share one.
    expect(create()).not.toBe(create())
  })
})

describe('removePackagingTmpdir', () => {
  it('removes the directory and everything staged inside it', () => {
    const dir = create()
    writeFileSync(path.join(dir, 'staged'), '')

    removePackagingTmpdir(dir)

    expect(existsSync(dir)).toBe(false)
  })

  it('does nothing when the directory is already gone', () => {
    const dir = create()
    removePackagingTmpdir(dir)

    expect(() => removePackagingTmpdir(dir)).not.toThrow()
  })

  it('refuses to delete a directory it did not create', () => {
    const foreign = mkdtempSync(path.join(os.tmpdir(), 'not-a-packaging-run-'))

    try {
      expect(() => removePackagingTmpdir(foreign)).toThrow(
        /not a packaging temp directory/i,
      )
      expect(existsSync(foreign)).toBe(true)
    } finally {
      rmSync(foreign, { recursive: true, force: true })
    }
  })

  it('accepts the prefix the helper stages under', () => {
    expect(path.basename(create())).toMatch(
      new RegExp(`^${PACKAGING_TMPDIR_PREFIX}`),
    )
  })
})
