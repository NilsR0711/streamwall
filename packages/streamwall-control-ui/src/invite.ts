import { z } from 'zod'

/**
 * Runtime shape of a successful `create-invite` response. The control server
 * only sends this once the response has already been checked for an
 * `{ error }` shape (see `commandError.ts`), but a server-side bug, future
 * field rename, or client/server version skew could still send a "success"
 * payload that doesn't actually match — so this is validated rather than
 * cast (issue #296).
 */
export const inviteResponseSchema = z.object({
  tokenId: z.string(),
  name: z.string(),
  secret: z.string(),
})

export type Invite = z.infer<typeof inviteResponseSchema>

/** Validates an untrusted `create-invite` response, returning `null` instead of throwing or silently accepting malformed data. */
export function parseInviteResponse(response: unknown): Invite | null {
  const result = inviteResponseSchema.safeParse(response)
  return result.success ? result.data : null
}
