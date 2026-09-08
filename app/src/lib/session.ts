// Reading who is signed in.
//
// The cookie is named `__Host-rs_session`. That prefix is not decoration: a
// browser will only accept such a cookie when it is Secure, has Path=/, and
// carries no Domain, which means it cannot be set by a sibling subdomain.
//
// Clearing it needs care. Observed on 2 September 2026: `cookies().delete(name)`
// emits `__Host-rs_session=; Path=/; Expires=Thu, 01 Jan 1970` with **no Secure
// attribute**, and a browser refuses that for a `__Host-` cookie, so the person
// stays signed in. Both working forms carry Secure explicitly; this file uses
// the empty-value form and so must every other caller.

import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { withWatchTarget, parseWatchTarget, type WatchTarget } from './watch'
import { query, DatabaseError } from './db'
import { isTokenShaped, hashToken } from './tokens'

export const SESSION_COOKIE = '__Host-rs_session'
export const SESSION_DAYS = 30

export type User = { id: string; email: string }

export type UserOrOutage = { kind: 'user'; user: User } | { kind: 'outage' }

/** The cookie attributes used both to set and to clear. Secure is never off. */
function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  }
}

/** Write the session cookie. Only a route handler may call this. */
export async function setSessionCookie(rawToken: string): Promise<void> {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, rawToken, cookieOptions(60 * 60 * 24 * SESSION_DAYS))
}

/**
 * Remove the session cookie.
 *
 * An empty value with maxAge 0 rather than `delete(name)`, because the latter
 * omits Secure and a browser therefore ignores it for a `__Host-` cookie.
 */
export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, '', cookieOptions(0))
}

/**
 * Where somebody was going when they were stopped to sign in.
 *
 * A cookie rather than a parameter on the emailed link, and that is a privacy
 * decision rather than a technical one. Resend keeps a copy of every message it
 * sends for 30 days, and the account page promises exactly that in those words.
 * A watch target in the link would put an item from a person's watchlist into
 * that retained copy, and a watchlist is personal data under MASTER-DESIGN
 * rule 8. This was written into HANDOFF.md as a decision before it was built,
 * then broken by the first implementation, then put back.
 *
 * The cost is honest and small: the cookie is on the device that asked, so
 * opening the emailed link on a *different* device loses the target and lands
 * on the feed, which is where a plain sign in has always led. The case that
 * matters is a phone, where the mail app and the browser share a cookie jar.
 *
 * Twenty minutes because the link itself lasts fifteen, so the cookie outlives
 * anything that could still use it and not much longer.
 */
const WATCH_COOKIE = '__Host-rs_watch'
const WATCH_COOKIE_SECONDS = 20 * 60

export async function rememberWatchIntent(target: WatchTarget | null): Promise<void> {
  const jar = await cookies()
  if (target === null) {
    // Clear any older intent, so a plain sign in cannot inherit one.
    jar.set(WATCH_COOKIE, '', cookieOptions(0))
    return
  }
  jar.set(
    WATCH_COOKIE,
    `${target.kind}:${encodeURIComponent(target.key)}`,
    cookieOptions(WATCH_COOKIE_SECONDS),
  )
}

/** Read the stored intent without consuming it. For failure paths. */
export async function peekWatchIntent(): Promise<WatchTarget | null> {
  return readWatchCookie(await cookies())
}

function readWatchCookie(jar: Awaited<ReturnType<typeof cookies>>): WatchTarget | null {
  const raw = jar.get(WATCH_COOKIE)?.value
  if (typeof raw !== 'string' || raw === '') return null
  const colon = raw.indexOf(':')
  if (colon < 0) return null
  try {
    return parseWatchTarget(raw.slice(0, colon), decodeURIComponent(raw.slice(colon + 1)))
  } catch {
    // decodeURIComponent throws on a malformed sequence. A broken cookie is
    // simply no intent.
    return null
  }
}

/**
 * Read and forget the stored intent.
 *
 * The value is put back through `parseWatchTarget`, so a cookie somebody edited
 * by hand is worth no more than one this application wrote. It can only ever
 * name a `/watch` address on this origin.
 */
export async function takeWatchIntent(): Promise<WatchTarget | null> {
  const jar = await cookies()
  const target = readWatchCookie(jar)
  jar.set(WATCH_COOKIE, '', cookieOptions(0))
  return target
}

/** The raw cookie value, if it is even the right shape to look up. */
export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies()
  const raw = jar.get(SESSION_COOKIE)?.value
  return isTokenShaped(raw) ? raw : null
}

/**
 * Who is signed in, or null.
 *
 * Wrapped in React's cache() so that one server-component render pass makes one
 * query even when several parts of the page ask. It does not memoise inside a
 * route handler, so a handler calls this once and passes the result down.
 *
 * It never catches DatabaseError. That is load-bearing. Turning an outage into
 * null would redirect a signed-in person to the sign-in page as though they had
 * signed out, and would render an empty feed implying there was nothing to
 * find. Saying "there is nothing" when the truth is "we could not look" is the
 * one thing this product must not do.
 */
export const getCurrentUser = cache(async function getCurrentUser(): Promise<User | null> {
  const raw = await readSessionToken()
  if (raw === null) return null

  const rows = await query<User>(
    `select u.id, u.email
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1
        and s.expires_at > now()`,
    [hashToken(raw)],
  )
  return rows[0] ?? null
})

/**
 * For server components only.
 *
 * Returns the user, or reports an outage so the page can say so plainly, or
 * redirects to the sign-in page when nobody is signed in.
 *
 * `returnToWatch` is the thing the person was trying to watch when they were
 * stopped, and it survives the whole sign-in flow so they are put back where
 * they were. It is a **parsed** WatchTarget, not a path: a caller cannot hand
 * this function a destination, so it cannot be turned into an open redirect.
 * The only address it can produce is `/sign-in` on this origin, with a key that
 * has already passed `parseWatchTarget`.
 */
export async function requireUser(returnToWatch?: WatchTarget | null): Promise<UserOrOutage> {
  let user: User | null
  try {
    user = await getCurrentUser()
  } catch (err) {
    // Only an outage is handled here. Anything else, including the control-flow
    // signal that redirect() throws, must keep travelling.
    if (err instanceof DatabaseError) return { kind: 'outage' }
    throw err
  }
  // Deliberately outside the try, so redirect()'s own thrown signal is never
  // swallowed by the catch above.
  if (user === null) redirect(withWatchTarget('/sign-in', returnToWatch ?? null))
  return { kind: 'user', user }
}

