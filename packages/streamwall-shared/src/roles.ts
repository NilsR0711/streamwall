export const validRoles = ['local', 'admin', 'operator', 'monitor'] as const
export const validRolesSet = new Set(validRoles)

type AdminAction = 'dev-tools' | 'browse' | 'create-invite' | 'delete-token'

const operatorActions = [
  'set-listening-view',
  'set-view-background-listening',
  'set-view-blurred',
  'update-custom-stream',
  'delete-custom-stream',
  'rotate-stream',
  'reload-view',
  'set-view-fullscreen',
  'set-stream-censored',
  'set-stream-running',
  'mutate-state-doc',
  'set-grid-size',
  'save-layout-preset',
  'load-layout-preset',
  'delete-layout-preset',
  'set-view-volume',
  'add-favorite',
  'remove-favorite',
] as const

const monitorActions = ['set-view-blurred', 'set-stream-censored'] as const

export type StreamwallRole = (typeof validRoles)[number]

// Roles that may be granted to a new user via an invite token. `local` is
// reserved for the Streamwall app's own IPC connection (see `roleCan` below,
// where it is treated as all-powerful just like `admin`) and is never
// something an admin should be able to invite someone else into.
export const invitableRoles = [
  'admin',
  'operator',
  'monitor',
] as const satisfies readonly StreamwallRole[]
export type InvitableRole = (typeof invitableRoles)[number]

const invitableRoleSet = new Set<string>(invitableRoles)

export function isInvitableRole(role: string): role is InvitableRole {
  return invitableRoleSet.has(role)
}

export type StreamwallAction =
  | AdminAction
  | (typeof operatorActions)[number]
  | (typeof monitorActions)[number]

const operatorActionSet = new Set<StreamwallAction>(operatorActions)
const monitorActionSet = new Set<StreamwallAction>(monitorActions)

export function roleCan(role: StreamwallRole | null, action: StreamwallAction) {
  if (role === 'admin' || role === 'local') {
    return true
  }

  if (role === 'operator' && operatorActionSet.has(action)) {
    return true
  }

  if (role === 'monitor' && monitorActionSet.has(action)) {
    return true
  }

  return false
}

export function inviteLink({
  baseURL = '',
  tokenId,
  secret,
}: {
  baseURL?: string
  tokenId: string
  secret: string
}) {
  // The secret goes in the URL fragment, which browsers never send to the
  // server: it stays out of access logs, the `Referer` header, and the request
  // line. The invite page reads it client-side and exchanges it via POST.
  return `${baseURL}/invite/${tokenId}#token=${secret}`
}
