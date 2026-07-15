import { z } from 'zod'

/**
 * Runtime shape of the collaborative `views` state shared between every
 * connected client and the Electron main process over the Yjs doc. `useYDoc`
 * validates each doc snapshot against this schema rather than casting it, so
 * a stale client on an old schema, a manual doc edit, or a future field
 * rename surfaces as a dropped update instead of silently corrupting the UI
 * (issue #322).
 */
export const collabDataSchema = z.object({
  views: z.record(z.string(), z.object({ streamId: z.string().optional() })),
})

export type CollabData = z.infer<typeof collabDataSchema>
