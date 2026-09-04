// POST /account/delete
//
// Deletion means deletion. There is no deleted_at, is_active or archived column
// anywhere in the schema, so there is no way to express "gone but still here".
//
// It is two statements. Everything that describes a person hangs off users(id)
// with ON DELETE CASCADE, so removing that row takes the sessions, the
// watchlist, the preferences and the delivery records with it. Pending sign-in
// tokens are keyed by address rather than by user id, because they exist before
// an account does, so they need their own statement.

import { see, forbidden } from '@/lib/http'
import { isSameOrigin } from '@/lib/same-origin'
import { query, DatabaseError } from '@/lib/db'
import { log, errorFacts } from '@/lib/log'
import { getCurrentUser, clearSessionCookie } from '@/lib/session'

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden()

  let user
  try {
    user = await getCurrentUser()
  } catch (err) {
    if (err instanceof DatabaseError) {
      log({ event: 'account_delete_failed', ...errorFacts(err) })
      return see('/account?problem=delete')
    }
    throw err
  }
  if (!user) return see('/sign-in')

  const form = await request.formData()
  if (form.get('confirm') !== 'yes') return see('/account?problem=confirm')

  try {
    // Cascades sessions, watch_items, alert_preferences and event_deliveries.
    await query('delete from users where id = $1', [user.id])
    // No foreign key to users, so this one is explicit.
    await query('delete from sign_in_tokens where email = $1', [user.email])
  } catch (err) {
    if (err instanceof DatabaseError) {
      // The message on that page says the deletion did not complete, and
      // deliberately does not say nothing was removed. If the first statement
      // succeeded and the second threw, the account really is gone; claiming
      // otherwise would be the more comfortable lie.
      log({ event: 'account_delete_failed', ...errorFacts(err) })
      return see('/account?problem=delete')
    }
    throw err
  }

  // The session rows are already gone with the user. Clearing the cookie stops
  // this browser presenting a value that now matches nothing.
  await clearSessionCookie()
  log({ event: 'account_deleted' })
  return see('/deleted')
}
