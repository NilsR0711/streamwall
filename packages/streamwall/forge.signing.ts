export type SigningEnv = Partial<
  Record<
    | 'APPLE_TEAM_ID'
    | 'APPLE_API_KEY'
    | 'APPLE_API_KEY_ID'
    | 'APPLE_API_ISSUER'
    | 'WINDOWS_CERTIFICATE_FILE'
    | 'WINDOWS_CERTIFICATE_PASSWORD',
    string | undefined
  >
>

export interface MacSigningConfig {
  /** Empty object enables signing with the identity already in the keychain (see docs). */
  osxSign: Record<string, never>
  osxNotarize: {
    appleApiKey: string
    appleApiKeyId: string
    appleApiIssuer: string
  }
}

/**
 * Builds the macOS signing/notarization config from App Store Connect API key
 * credentials (`xcrun notarytool`'s recommended, non-interactive auth method).
 * Returns undefined when the credentials aren't fully configured, so builds
 * without secrets (e.g. local contributor machines) stay unsigned as today.
 */
export function getMacSigningConfig(
  env: SigningEnv,
): MacSigningConfig | undefined {
  const { APPLE_TEAM_ID, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } =
    env
  if (
    !APPLE_TEAM_ID ||
    !APPLE_API_KEY ||
    !APPLE_API_KEY_ID ||
    !APPLE_API_ISSUER
  ) {
    return undefined
  }

  return {
    osxSign: {},
    osxNotarize: {
      appleApiKey: APPLE_API_KEY,
      appleApiKeyId: APPLE_API_KEY_ID,
      appleApiIssuer: APPLE_API_ISSUER,
    },
  }
}

export interface WindowsSigningConfig {
  certificateFile: string
  certificatePassword: string
}

/**
 * Builds the Windows Squirrel installer signing config from a PFX
 * certificate. Returns undefined when unconfigured, leaving Windows builds
 * unsigned as today.
 */
export function getWindowsSigningConfig(
  env: SigningEnv,
): WindowsSigningConfig | undefined {
  const { WINDOWS_CERTIFICATE_FILE, WINDOWS_CERTIFICATE_PASSWORD } = env
  if (!WINDOWS_CERTIFICATE_FILE || !WINDOWS_CERTIFICATE_PASSWORD) {
    return undefined
  }

  return {
    certificateFile: WINDOWS_CERTIFICATE_FILE,
    certificatePassword: WINDOWS_CERTIFICATE_PASSWORD,
  }
}

export function isSigningConfigured(env: SigningEnv): boolean {
  return (
    getMacSigningConfig(env) !== undefined ||
    getWindowsSigningConfig(env) !== undefined
  )
}
