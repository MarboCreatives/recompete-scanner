// POST /auth/sign-out
//
// Deleting the row is what makes signing out real. Clearing the cookie only
// stops this browser presenting the value; the row is what the server trusts,
// so a copied cookie would still work until it expired.

import { see, forbidden } from '@/lib/http'
import { isSameOrigin } from '@/lib/same-origin'
import { hashToken } from '@/lib/tokens'
import { query, DatabaseError } from '@/lib/db'
import { log, errorFacts } from '@/lib/log'
import { readSessionToken, clearSessionCookie } from '@/lib/session'

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden()

  const raw = await readSessionToken()
  // No cookie, or one that could not be a token: nothing to delete, and no
  // reason to touch the database.
  if (raw === null) return see('/')

  try {
    await query('delete from sessions where token_hash = $1', [hashToken(raw)])
  } catch (err) {
    if (err instanceof DatabaseError) {
      log({ event: 'sign_out_failed', ...errorFacts(err) })
      // Clear the cookie anyway. It is strictly better than not clearing it:
      // this browser can no longer present the value. What survives is a row
      // whose raw token only this browser held. The page says exactly that
      // rather than claiming a clean sign-out.
      await clearSessionCookie()
      return see('/sign-in?problem=signout')
    }
    throw err
  }

  await clearSessionCookie()
  return see('/')
}
