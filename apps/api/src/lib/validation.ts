import type { Hook } from '@hono/standard-validator'
import type { AppEnv } from '../middleware/auth'

// Every hand-written check across the routes returns `{ error: string }` —
// migrating a route to a schema shouldn't change its wire contract, so this
// replaces standard-schema's default issue-array response with the same
// flat shape, taking the first issue's message.
export const badRequest: Hook<unknown, AppEnv, string> = (result, c) => {
  if (!result.success) return c.json({ error: result.error[0]?.message ?? 'invalid request' }, 400)
}
