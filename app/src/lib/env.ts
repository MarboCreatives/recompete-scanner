// Every environment variable the application reads passes through here, so
// there is one place to look for what it needs and one place that fails when
// something is missing.
//
// Nothing in this file runs at module load. A missing variable must fail on the
// request that needs it, with a sentence saying which one, rather than at import
// time during a build where the message is buried in a bundler trace.

/** Read a required variable, or throw a sentence naming it. */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `${name} is not set. Add it in the Vercel project settings, or to app/.env.local ` +
        'for local work. The full list is in docs/ENVIRONMENT.md.',
    )
  }
  return value
}

/** Read an optional variable. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** True only on a real production deployment. */
export function isProduction(): boolean {
  return process.env.VERCEL_ENV === 'production'
}

/**
 * Where this deployment is reachable, used to build the link inside a sign-in
 * email. It is never taken from the Host header, because an attacker who can
 * set that header could otherwise have the link point at their own site.
 */
export function appUrl(): string {
  const explicit = optionalEnv('APP_URL')
  if (explicit) return explicit.replace(/\/+$/, '')

  // On a preview deployment the branch URL is the only address that works, and
  // it is supplied by the platform rather than by the request.
  const branch = optionalEnv('VERCEL_BRANCH_URL')
  if (branch) return `https://${branch}`

  const local = optionalEnv('PORT') ?? '3000'
  if (!isProduction()) return `http://127.0.0.1:${local}`

  throw new Error(
    'APP_URL is not set and no platform URL was available. A sign-in link cannot ' +
      'be built without knowing this deployment address.',
  )
}

/**
 * True when a sign-in link should be printed to the server output instead of
 * emailed. This lets the whole flow be built and tested before any email
 * account exists.
 *
 * It is refused outright in production. A dry run on the live site would mean
 * people asking for a link and never receiving one, with the link sitting in a
 * log where it should never be.
 */
export function emailDryRun(): boolean {
  const on = optionalEnv('EMAIL_DRY_RUN') === '1'
  if (on && isProduction()) {
    throw new Error(
      'EMAIL_DRY_RUN is set on a production deployment. That would print sign-in ' +
        'links to the log instead of sending them. Remove it from the Production ' +
        'environment in the Vercel project settings.',
    )
  }
  return on
}
