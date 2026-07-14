import { describe, expect, it } from 'vitest'
import {
  isSentryEnabledArg,
  SENTRY_ENABLED_SWITCH,
  sentryEnabledSwitchValue,
} from './sentryConfig'

describe('sentryEnabledSwitchValue', () => {
  it('renders true as the literal string "true"', () => {
    expect(sentryEnabledSwitchValue(true)).toBe('true')
  })

  it('renders false as the literal string "false"', () => {
    expect(sentryEnabledSwitchValue(false)).toBe('false')
  })
})

describe('isSentryEnabledArg', () => {
  it('is true when the switch is present and set to true', () => {
    expect(isSentryEnabledArg([`--${SENTRY_ENABLED_SWITCH}=true`])).toBe(true)
  })

  it('is false when the switch is present and set to false', () => {
    expect(isSentryEnabledArg([`--${SENTRY_ENABLED_SWITCH}=false`])).toBe(false)
  })

  it('is false when the switch is absent', () => {
    expect(isSentryEnabledArg(['--some-other-flag=true'])).toBe(false)
  })

  it('is false for an empty argv', () => {
    expect(isSentryEnabledArg([])).toBe(false)
  })
})
