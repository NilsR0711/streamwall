import { describe, expect, test } from 'vitest'
import {
  getMacSigningConfig,
  getWindowsSigningConfig,
  isSigningConfigured,
} from './forge.signing'

describe('getMacSigningConfig', () => {
  test('returns undefined when no Apple credentials are set', () => {
    expect(getMacSigningConfig({})).toBeUndefined()
  })

  test('returns undefined when only some Apple credentials are set', () => {
    expect(
      getMacSigningConfig({
        APPLE_TEAM_ID: 'TEAM123',
        APPLE_API_KEY: '/path/to/key.p8',
      }),
    ).toBeUndefined()
  })

  test('returns osxSign/osxNotarize config when all Apple credentials are set', () => {
    const config = getMacSigningConfig({
      APPLE_TEAM_ID: 'TEAM123',
      APPLE_API_KEY: '/path/to/key.p8',
      APPLE_API_KEY_ID: 'KEYID123',
      APPLE_API_ISSUER: 'issuer-uuid',
    })

    expect(config).toEqual({
      osxSign: {},
      osxNotarize: {
        appleApiKey: '/path/to/key.p8',
        appleApiKeyId: 'KEYID123',
        appleApiIssuer: 'issuer-uuid',
      },
    })
  })
})

describe('getWindowsSigningConfig', () => {
  test('returns undefined when no certificate is configured', () => {
    expect(getWindowsSigningConfig({})).toBeUndefined()
  })

  test('returns undefined when only the certificate file is set', () => {
    expect(
      getWindowsSigningConfig({ WINDOWS_CERTIFICATE_FILE: './cert.pfx' }),
    ).toBeUndefined()
  })

  test('returns certificateFile/certificatePassword when both are set', () => {
    expect(
      getWindowsSigningConfig({
        WINDOWS_CERTIFICATE_FILE: './cert.pfx',
        WINDOWS_CERTIFICATE_PASSWORD: 'hunter2',
      }),
    ).toEqual({
      certificateFile: './cert.pfx',
      certificatePassword: 'hunter2',
    })
  })
})

describe('isSigningConfigured', () => {
  test('is false when neither macOS nor Windows signing is configured', () => {
    expect(isSigningConfigured({})).toBe(false)
  })

  test('is true when macOS signing is configured', () => {
    expect(
      isSigningConfigured({
        APPLE_TEAM_ID: 'TEAM123',
        APPLE_API_KEY: '/path/to/key.p8',
        APPLE_API_KEY_ID: 'KEYID123',
        APPLE_API_ISSUER: 'issuer-uuid',
      }),
    ).toBe(true)
  })

  test('is true when Windows signing is configured', () => {
    expect(
      isSigningConfigured({
        WINDOWS_CERTIFICATE_FILE: './cert.pfx',
        WINDOWS_CERTIFICATE_PASSWORD: 'hunter2',
      }),
    ).toBe(true)
  })
})
