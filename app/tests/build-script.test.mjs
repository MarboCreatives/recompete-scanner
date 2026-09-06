// The build script must still run the deploy migration before `next build`.
//
// This exists because of GROUND-TRUTH G16: production ran for two days with a
// merged schema and zero tables, because the build script was `next build`
// alone and nothing applied the migrations on Vercel. The fix was to put
// `node scripts/deploy-migrate.mjs &&` in front of it. Nothing then asserted
// that it stayed there. A framework codemod, a dependency upgrade that rewrites
// package.json, or a tidy-up would drop it, every other check would stay green,
// and the live database would silently stop being migrated.
//
// Reading package.json is the whole check. It needs no database and no server,
// so it runs anywhere, including a CI job with no secrets.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

test('the build script runs the deploy migration before next build', () => {
  const build = pkg.scripts?.build
  assert.equal(typeof build, 'string', 'package.json must have a build script')
  // The exact prefix, not a substring anywhere in the line: the migration must
  // run FIRST and must gate the build with &&, so a failed migration fails the
  // deploy rather than building code against a schema it does not match.
  assert.ok(
    build.startsWith('node scripts/deploy-migrate.mjs && '),
    `the build script must begin with "node scripts/deploy-migrate.mjs && "; it is "${build}"`,
  )
  assert.ok(build.includes('next build'), 'the build script must still build the app')
})

test('the files the build script names exist', () => {
  // A build script that names a missing file fails every deploy, which is loud
  // and fine. This case is here so the failure names the file rather than
  // surfacing as an unexplained exit code in a Vercel log.
  assert.ok(existsSync(join(here, '..', 'scripts', 'deploy-migrate.mjs')), 'scripts/deploy-migrate.mjs must exist')
  assert.ok(existsSync(join(here, '..', 'scripts', 'migrate.mjs')), 'scripts/migrate.mjs must exist')
})
