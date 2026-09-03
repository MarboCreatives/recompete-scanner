// POST /auth/request — someone asks for a sign-in link.
//
// No user row is ever consulted here, so the response is the same whether or
// not an account exists. There is no way to use this route to learn who has
// signed up.

import { see, forbidden } from '@/lib/http'
import { isSameOrigin } from '@/lib/same-origin'
import { normalizeEmail } from '@/lib/normalize-email'
import { newToken, hashToken } from '@/lib/tokens'
import { query, DatabaseError } from '@/lib/db'
import { log, errorFacts } from '@/lib/log'
import { sendEmail } from '@/lib/email'
import { signInLinkEmail, SIGN_IN_SUBJECT } from '@/lib/email-templates'
import { appUrl } from '@/lib/env'

/** Links one address may ask for in an hour. */
const PER_ADDRESS_HOURLY_CAP = 5
/** Links the whole site may send in an hour. */
const GLOBAL_HOURLY_CAP = 20

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden()

  const form = await request.formData()
  const email = normalizeEmail(form.get('email'))
  // Saying the address is malformed reveals nothing about who has an account,
  // and swallowing a typo would produce a confident "check your inbox" for a
  // message that could never arrive.
  if (email === null) return see('/sign-in?problem=address')

  let raw: string
  let hash: string
  try {
    // Tidy up before counting, so expired rows do not hold the caps down.
    // The hour of grace is deliberate: the caps charge failed sends, and need
    // the rows for that long. The privacy policy states this in those terms.
    await query("delete from sign_in_tokens where expires_at < now() - interval '1 hour'")
    await query('delete from sessions where expires_at < now()')

    const perAddress = await query<{ n: number }>(
      `select count(*)::int as n from sign_in_tokens
        where email = $1 and created_at > now() - interval '1 hour'`,
      [email],
    )
    if ((perAddress[0]?.n ?? 0) >= PER_ADDRESS_HOURLY_CAP) {
      // No address in the line; the event name is the whole message.
      log({ event: 'sign_in_address_cap_reached' })
      return see('/sign-in?problem=too-many')
    }

    // Without a global cap, one script using many different addresses buys five
    // sends each, which burns the daily sending quota and, once a sending
    // domain is verified, mails strangers from this domain.
    const global = await query<{ n: number }>(
      `select count(*)::int as n from sign_in_tokens
        where created_at > now() - interval '1 hour'`,
    )
    if ((global[0]?.n ?? 0) >= GLOBAL_HOURLY_CAP) {
      log({ event: 'sign_in_global_cap_reached' })
      return see('/sign-in?problem=busy')
    }

    raw = newToken()
    hash = hashToken(raw)
    // Fifteen minutes appears here, on the sent page, and in the email. All
    // three are the same promise written three times.
    await query(
      `insert into sign_in_tokens (token_hash, email, expires_at)
       values ($1, $2, now() + interval '15 minutes')`,
      [hash, email],
    )
  } catch (err) {
    if (err instanceof DatabaseError) {
      log({ event: 'sign_in_request_failed', ...errorFacts(err) })
      return see('/sign-in?problem=unreachable')
    }
    throw err
  }

  // Built from the configured address, never from a request header. Someone who
  // can set the Host header could otherwise point the link at their own site.
  const url = `${appUrl()}/sign-in/verify?token=${raw}`
  const body = signInLinkEmail(url)

  const sent = await sendEmail({
    to: email,
    subject: SIGN_IN_SUBJECT,
    text: body.text,
    html: body.html,
    idempotencyKey: `sign-in/${hash}`,
    dryRunUrl: url,
  })

  if (!sent.ok) {
    // The token row is kept on purpose. If a failed send released the cap, a
    // script could buy unlimited attempts by choosing addresses that fail.
    log({ event: 'sign_in_email_failed', status: sent.status ?? 0 })
    return see('/sign-in?problem=email')
  }

  // Reached only when a send actually succeeded, so the sentence on that page
  // is true wherever it is rendered.
  return see('/sign-in/sent')
}
