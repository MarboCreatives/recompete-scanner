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
import { parseWatchTarget, parseWatchLabels, MAX_WATCH_ITEMS } from '@/lib/watch'

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

  // The caption to show on the row. Refusing a watch because its caption was
  // unusable would be the wrong trade every time, so parseWatchLabels cannot
  // fail: a caption it will not accept is simply absent, and the watchlist has
  // a sentence for that. Nothing below looks anything up by it.
  const labels = parseWatchLabels(form.get('kind'), form.get('name'), form.get('dept'))

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
    //
    // It is an UPDATE rather than DO NOTHING so that pressing Watch again is
    // how a row saved without a caption acquires one. Every row written before
    // 0003_watch_labels.sql has none and there is nothing to backfill them
    // from, so this is the only route by which they ever become readable, and
    // the watchlist tells people to use it in those words.
    //
    // coalesce, so the new value wins only when there IS one. A link that
    // carries no name must not blank a name already on the row: the same
    // contract is reachable from a bookmark saved before the site sent
    // captions, and following it would otherwise quietly undo the fix.
    await query(
      `insert into watch_items (user_id, kind, target_key, label_name, label_dept)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id, kind, target_key) do update
          set label_name = coalesce(excluded.label_name, watch_items.label_name),
              label_dept = coalesce(excluded.label_dept, watch_items.label_dept)`,
      [user.id, target.kind, target.key, labels.name, labels.dept],
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
