// Applies migrations during a deployment, and only during the right ones.
//
// This exists because a check found production with zero tables: the build
// script was `next build` alone, so the schema had never been created there and
// the first person to try signing in would have hit a missing table.
//
// Why it is gated rather than always running: all three Vercel environments
// currently share one database. A preview deployment of a branch carrying a new
// migration would therefore apply that migration to production before the pull
// request was reviewed or merged. Migrating from production builds only means a
// schema change lands at the same moment as the code that needs it.
//
// Preview deployments are unaffected: they read the same database, which
// production has already migrated.
//
// A failed migration fails the build, on purpose. Deploying code against a
// schema that does not match it is the more expensive failure, and it surfaces
// as a broken site rather than as a red build.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const vercelEnv = process.env.VERCEL_ENV

// Not on Vercel at all: a local `npm run build`. Do not touch any database.
if (!vercelEnv) {
  console.log('Not a Vercel build; skipping migrations. Run `npm run migrate` by hand.')
  process.exit(0)
}

if (vercelEnv !== 'production') {
  console.log(
    `Vercel environment is "${vercelEnv}"; skipping migrations. ` +
      'Only production builds migrate, so an unmerged branch cannot change the ' +
      'schema underneath the live site.',
  )
  process.exit(0)
}

if (!process.env.DATABASE_URL_UNPOOLED) {
  console.error('')
  console.error('DEPLOY FAILED')
  console.error('DATABASE_URL_UNPOOLED is not set on this production build, so the')
  console.error('schema cannot be applied. It is normally set by the Neon integration')
  console.error('in the Vercel project settings.')
  process.exit(1)
}

console.log('Production build; applying migrations before the app is built.')
const result = spawnSync(process.execPath, [join(here, 'migrate.mjs')], {
  stdio: 'inherit',
  env: process.env,
})
process.exit(result.status ?? 1)
