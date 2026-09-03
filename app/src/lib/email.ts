// Sending, and the dry run that makes the whole flow testable without an email
// account.
//
// There is no `resend` package here. Sending is one HTTPS POST with a bearer
// token, and a dependency that wraps one fetch call is a dependency that can
// break, needs updating, and hides what is actually on the wire.

import { optionalEnv, requireEnv, emailDryRun, isProduction } from './env'
import { log } from './log'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export type SendResult = { ok: true } | { ok: false; status?: number }

export type SendArgs = {
  to: string
  subject: string
  text: string
  html: string
  /** Makes a retry of the same message harmless; Resend keeps these 24 hours. */
  idempotencyKey: string
  /** The link, logged in a dry run so the flow can be followed without email. */
  dryRunUrl?: string
}

/**
 * Send one message, or print it instead when running without an email account.
 *
 * The dry run exists so sign-in can be built and tested end to end before any
 * sending domain is verified. It is refused outright on a production
 * deployment: printing a link there would mean people asking for a sign-in link,
 * never receiving one, and the link sitting in a log where it must never be.
 * That refusal lives in env.ts and throws rather than returning false, because
 * a misconfiguration of this kind must stop the request, not proceed quietly.
 */
export async function sendEmail(args: SendArgs): Promise<SendResult> {
  if (emailDryRun()) {
    // The url is the whole point of the line. The address is deliberately not
    // included; log() would drop it in any case, because it contains an at sign.
    log({ event: 'sign_in_link_dry_run', reason: args.dryRunUrl ?? '' })
    return { ok: true }
  }

  const apiKey = optionalEnv('RESEND_API_KEY')
  if (!apiKey) {
    // Reached only when the dry run is off and no key is configured. Say which
    // setting is missing rather than failing with a network error.
    log({ event: 'send_skipped_no_api_key' })
    return { ok: false }
  }

  const from = requireEnv('EMAIL_FROM')
  const base = optionalEnv('RESEND_BASE_URL')
  if (base && isProduction()) {
    // A stub endpoint left set in production would send every sign-in link
    // nowhere, silently. Fail loudly instead.
    throw new Error(
      'RESEND_BASE_URL is set on a production deployment. That would send every ' +
        'message to a test endpoint. Remove it from the Production environment.',
    )
  }

  try {
    const response = await fetch(base ?? RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': args.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [args.to],
        subject: args.subject,
        text: args.text,
        html: args.html,
      }),
    })

    if (!response.ok) {
      // The body is not read and never logged. Resend's error text echoes the
      // recipient address back; with the test sender it says outright which
      // address owns the account.
      log({ event: 'send_failed', status: response.status })
      return { ok: false, status: response.status }
    }
    return { ok: true }
  } catch {
    // A network failure. The thrown error is not logged, because a fetch error
    // message can contain the whole request URL.
    log({ event: 'send_error' })
    return { ok: false }
  }
}
