// POST /auth/confirm — the person pressed the button on the link page.
//
// Confirmation is a POST rather than the link itself doing the work, because
// mail scanners and link previewers follow URLs in email. If opening the link
// signed someone in, a scanner would burn the token before the person saw it.

import { see, forbidden } from '@/lib/http'
import { isSameOrigin } from '@/lib/same-origin'
import { isTokenShaped, newToken, hashToken } from '@/lib/tokens'
import { query, queryOne, DatabaseError } from '@/lib/db'
import { log, errorFacts } from '@/lib/log'
import {
  setSessionCookie,
  SESSION_DAYS,
  takeWatchIntent,
  peekWatchIntent,
} from '@/lib/session'
import { watchPath, withWatchTarget, NO_LABELS } from '@/lib/watch'

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden()

  const form = await request.formData()

  // Read before the first exit, and NOT consumed. The person was promised a
  // return to what they were about to watch; a link that expired must not also
  // lose that, or asking for a new one starts them over from the public site.
  // It goes back onto the sign-in address so that page repopulates its form and
  // the next request stores the intent again.
  const intent = await peekWatchIntent()
  const backToSignIn = (problem: string) =>
    see(
      withWatchTarget(
        `/sign-in?problem=${problem}`,
        intent?.target ?? null,
        intent?.labels ?? NO_LABELS,
      ),
    )

  const token = form.get('token')
  if (!isTokenShaped(token)) return backToSignIn('expired')

  let email: string
  try {
    // One statement consumes the token: the delete takes the row lock, so two
    // simultaneous confirmations cannot both succeed. Expired, already used and
    // never existed are the same outcome here, and are told apart nowhere,
    // because distinguishing them would leak whether a link was ever issued.
    const consumed = await queryOne<{ email: string }>(
      `delete from sign_in_tokens
        where token_hash = $1 and expires_at > now()
        returning email`,
      [hashToken(token)],
    )
    if (!consumed) return backToSignIn('expired')
    email = consumed.email
  } catch (err) {
    if (err instanceof DatabaseError) {
      // Nothing was burned, so the same link still works once the database is
      // back. That is why this branch says "reach" and the one below does not.
      log({ event: 'sign_in_failed', ...errorFacts(err) })
      return backToSignIn('unreachable')
    }
    throw err
  }

  let rawSession: string
  try {
    await query("delete from sessions where expires_at < now()")

    const user = await queryOne<{ id: string }>(
      `insert into users (email, last_sign_in_at)
       values ($1, now())
       on conflict (email) do update set last_sign_in_at = now()
       returning id`,
      [email],
    )
    if (!user) throw new DatabaseError({})

    await query(
      'insert into alert_preferences (user_id) values ($1) on conflict do nothing',
      [user.id],
    )

    rawSession = newToken()
    // make_interval keeps the number a parameter. Interpolating it into the SQL
    // would work, since it is a constant in this file rather than anything a
    // person supplies, but "values are always parameters" is not a rule worth
    // having exceptions to; the next value someone interpolates might not be a
    // constant. The session length is defined once, in session.ts, and used
    // both for the cookie and for the row so the two cannot drift apart.
    await query(
      `insert into sessions (token_hash, user_id, expires_at)
       values ($1, $2, now() + make_interval(days => $3))`,
      [hashToken(rawSession), user.id, SESSION_DAYS],
    )
  } catch (err) {
    if (err instanceof DatabaseError) {
      // The token is already spent, so the honest instruction is to ask for a
      // new link rather than to retry this one.
      log({ event: 'sign_in_failed', ...errorFacts(err) })
      return backToSignIn('unavailable')
    }
    throw err
  }

  // Setting the cookie and returning a hand-built 303 in the same handler was
  // observed to work on 2 September 2026; the Set-Cookie is merged onto the
  // redirect and carries Secure, HttpOnly, SameSite=lax and Path=/.
  await setSessionCookie(rawSession)

  // Back to what they were about to watch. The intent comes from the cookie set
  // when the link was requested, not from this form and not from the link, so
  // nothing about a watchlist reaches the copy Resend keeps. It is re-parsed on
  // the way out, so the address can only ever be /watch on this origin; an
  // unparseable or absent value lands on the feed, which is where a plain sign
  // in has always led.
  await takeWatchIntent()
  return see(intent === null ? '/feed' : watchPath(intent.target, intent.labels))
}
