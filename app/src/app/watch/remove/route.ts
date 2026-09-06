// POST /watch/remove — stop watching one contract or one supplier.
//
// The DELETE is scoped by user_id as well as by the key. That is what stops
// one person's request removing another person's item: the key travels in the
// form, so without the user_id in the WHERE clause anyone could unwatch
// anything for everyone.
//
// Removing something that is not there is not an error. The person asked for
// it to be gone and it is gone; reporting a failure would be both confusing
// and a way to learn whether a given key was on the list.

import { see, forbidden } from '@/lib/http'
import { isSameOrigin } from '@/lib/same-origin'
import { query, DatabaseError } from '@/lib/db'
import { log, errorFacts } from '@/lib/log'
import { getCurrentUser } from '@/lib/session'
import { parseWatchTarget } from '@/lib/watch'

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden()

  let user
  try {
    user = await getCurrentUser()
  } catch (err) {
    if (err instanceof DatabaseError) {
      log({ event: 'watch_remove_failed', ...errorFacts(err) })
      return see('/watchlist?problem=remove')
    }
    throw err
  }
  if (!user) return see('/sign-in')

  const form = await request.formData()
  const target = parseWatchTarget(form.get('kind'), form.get('key'))
  if (target === null) return see('/watchlist?problem=invalid')

  try {
    await query('delete from watch_items where user_id = $1 and kind = $2 and target_key = $3', [
      user.id,
      target.kind,
      target.key,
    ])
  } catch (err) {
    if (err instanceof DatabaseError) {
      log({ event: 'watch_remove_failed', ...errorFacts(err) })
      return see('/watchlist?problem=remove')
    }
    throw err
  }

  log({ event: 'watch_removed' })
  return see('/watchlist')
}
