import type { SpawnSyncReturns } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { runTypecheck } from './forge.typecheck'

function spawnResult(
  overrides: Partial<SpawnSyncReturns<Buffer>> = {},
): SpawnSyncReturns<Buffer> {
  return {
    pid: 1,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 0,
    signal: null,
    ...overrides,
  }
}

describe('runTypecheck', () => {
  it('runs the package `typecheck` script', () => {
    const spawn = vi.fn(() => spawnResult())

    runTypecheck(spawn, 'linux')

    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, args] = spawn.mock.calls[0]
    expect(command).toBe('npm')
    expect(args).toEqual(['run', 'typecheck'])
  })

  // On Windows npm is only reachable as the `npm.cmd` shim, which Node
  // refuses to spawn without a shell since the CVE-2024-27980 fix. Without
  // `shell` the hook dies with ENOENT (bare `npm`) or EINVAL (`npm.cmd`) and
  // takes the whole packaging run down (#586).
  it('spawns through a shell on Windows', () => {
    const spawn = vi.fn(() => spawnResult())

    runTypecheck(spawn, 'win32')

    const [command, args, options] = spawn.mock.calls[0]
    expect(command).toBe('npm')
    expect(args).toEqual(['run', 'typecheck'])
    expect(options?.shell).toBe(true)
  })

  it('does not need a shell elsewhere', () => {
    const spawn = vi.fn(() => spawnResult())

    runTypecheck(spawn, 'linux')

    const [, , options] = spawn.mock.calls[0]
    expect(options?.shell).toBeFalsy()
  })

  it('runs in the package directory so it does not typecheck the caller workspace', () => {
    const spawn = vi.fn(() => spawnResult())

    runTypecheck(spawn)

    const [, , options] = spawn.mock.calls[0]
    expect(options?.cwd).toBe(import.meta.dirname)
  })

  it('streams tsc output to the terminal instead of swallowing it', () => {
    const spawn = vi.fn(() => spawnResult())

    runTypecheck(spawn)

    const [, , options] = spawn.mock.calls[0]
    expect(options?.stdio).toBe('inherit')
  })

  it('throws when the typecheck reports errors, aborting the packaging run', () => {
    const spawn = vi.fn(() => spawnResult({ status: 2 }))

    expect(() => runTypecheck(spawn)).toThrow(/typecheck failed/i)
  })

  it('throws when the typecheck is killed by a signal', () => {
    const spawn = vi.fn(() => spawnResult({ status: null, signal: 'SIGKILL' }))

    expect(() => runTypecheck(spawn)).toThrow(/SIGKILL/)
  })

  it('throws when npm cannot be spawned at all', () => {
    const spawn = vi.fn(() =>
      spawnResult({ status: null, error: new Error('spawn npm ENOENT') }),
    )

    expect(() => runTypecheck(spawn)).toThrow(/ENOENT/)
  })
})
