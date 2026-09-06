// POST /watch/add — start watching one contract or one supplier.
//
// Nothing here is logged beyond the fact that something was added. A watchlist
// is personal data under MASTER-DESIGN rule 8, and log() would drop a key
// anyway because no allowlisted field carries one; the point of saying so here
// is that the omission is deliberate rather than an oversight.

import { see, forbidden } from '@/lib/http'
import { isSameOrigin } from '@/lib/same-origin'
import { query, queryOne, DatabaseError } from '@/lib/db'
import { log, errorFacts } from '@/lib/log'
import { getCurrentUser } from '@/lib/session'
import { parseWatchTarget, MAX_WATCH_ITEMS } from '@/lib/watch'

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden()

  let user
  try {
    user = await getCurrentUser()
  } catch (err) {
    if (err instanceof DatabaseError) {
      log({ event: 'watch_add_failed', ...errorFacts(err) })
      return see('/watchlist?problem=add')
    }
    throw err
  }
  if (!user) return see('/sign-in')

  const form = await request.formData()
  // formData().get returns string | File | null; parseWatchTarget takes
  // unknown and refuses anything that is not a string before any pattern runs.
  const target = parseWatchTarget(form.get('kind'), form.get('key'))
  if (target === null) return see('/watchlist?problem=invalid')

  try {
    // Counted before inserting rather than after, so the limit is a refusal
    // with a sentence rather than a constraint violation with a 500.
    const count = await queryOne<{ n: number }>(
      'select count(*)::int as n from watch_items where user_id = $1',
      [user.id],
    )
    if ((count?.n ?? 0) >= MAX_WATCH_ITEMS) {
      log({ event: 'watch_limit_reached' })
      return see('/watchlist?problem=full')
    }

    // Pressing Watch twice on the same thing is not an error; the unique
    // constraint on (user_id, kind, target_key) absorbs it.
    await query(
      `insert into watch_items (user_id, kind, target_key)
       values ($1, $2, $3)
       on conflict (user_id, kind, target_key) do nothing`,
      [user.id, target.kind, target.key],
    )
  } catch (err) {
    if (err instanceof DatabaseError) {
      log({ event: 'watch_add_failed', ...errorFacts(err) })
      return see('/watchlist?problem=add')
    }
    throw err
  }

  log({ event: 'watch_added' })
  return see('/watchlist')
}
