import { isSecureControlEndpoint } from 'streamwall-shared'

export type ControlEndpointConnectDecision =
  | { action: 'skip'; reason: 'none' }
  | { action: 'skip'; reason: 'insecure'; endpoint: string }
  | { action: 'connect'; endpoint: string }

/**
 * Decides whether the desktop app should open a control-server uplink for the
 * configured endpoint. Insecure remote ws:// endpoints are refused.
 */
export function decideControlEndpointConnection(
  endpoint: string | null | undefined,
): ControlEndpointConnectDecision {
  if (!endpoint) {
    return { action: 'skip', reason: 'none' }
  }

  if (!isSecureControlEndpoint(endpoint)) {
    return { action: 'skip', reason: 'insecure', endpoint }
  }

  return { action: 'connect', endpoint }
}
