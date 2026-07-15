import { describe, expect, test } from 'vitest'
import log, { LOG_LEVELS, setLogLevel } from './logger'

describe('LOG_LEVELS', () => {
  test('lists every level electron-log supports, quietest to loudest', () => {
    expect(LOG_LEVELS).toEqual([
      'error',
      'warn',
      'info',
      'verbose',
      'debug',
      'silly',
    ])
  })
})

describe('setLogLevel', () => {
  test('sets both the file and console transport to the given level', () => {
    setLogLevel('warn')
    expect(log.transports.file.level).toBe('warn')
    expect(log.transports.console.level).toBe('warn')
  })

  test('supports the quietest level', () => {
    setLogLevel('error')
    expect(log.transports.file.level).toBe('error')
    expect(log.transports.console.level).toBe('error')
  })

  test('supports the loudest level', () => {
    setLogLevel('silly')
    expect(log.transports.file.level).toBe('silly')
    expect(log.transports.console.level).toBe('silly')
  })
})
