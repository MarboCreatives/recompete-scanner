// Rules about route handlers that can be checked by reading the files.
//
// Two rules, both recorded in PROGRESS.md's decisions and both learned by
// measurement:
//
//   1. No route handler imports `next/navigation`. Its redirect() answers 307
//      outside a Server Action, and a 307 after a form POST makes the browser
//      POST again to the destination. Every mutation here must answer a
//      hand-built 303 (src/lib/http.ts). Observed 2 September 2026 (G4).
//
//   2. Every route handler checks the request's origin first and handles
//      DatabaseError itself, because a route that catches nothing answers 500,
//      and an unhandled driver error prints the offending row value, which can
//      be an email address (G2).
//
// These are tripwires, not proofs: a route can call isSameOrigin() and ignore
// the answer. The HTTP-driven checks prove behaviour; this file catches the
// route that forgot the pattern entirely, before a server is even started.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(here, '..', 'src', 'app')

/** Every route.ts under src/app, found by walking rather than by a written list. */
function routeFiles(dir = APP_DIR, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) routeFiles(full, out)
    else if (name === 'route.ts') out.push(full)
  }
  return out
}

/** The file with comment-only lines removed, so a rule is never tripped by prose about it. */
function codeOnly(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

const routes = routeFiles()

test('there are route handlers to check', () => {
  // A walker that finds nothing would make every rule below pass vacuously.
  assert.ok(routes.length >= 4, `expected at least the four M0 routes, found ${routes.length}`)
})

test('no route handler imports next/navigation', () => {
  for (const file of routes) {
    const code = codeOnly(readFileSync(file, 'utf8'))
    assert.ok(
      !code.includes('next/navigation'),
      `${relative(APP_DIR, file)} imports next/navigation; its redirect() answers 307, not 303`,
    )
  }
})

test('every route handler checks the origin and handles DatabaseError', () => {
  for (const file of routes) {
    const code = codeOnly(readFileSync(file, 'utf8'))
    const name = relative(APP_DIR, file)
    assert.ok(code.includes('isSameOrigin('), `${name} does not call isSameOrigin()`)
    assert.ok(code.includes('DatabaseError'), `${name} does not handle DatabaseError`)
    assert.ok(code.includes('see('), `${name} does not use the 303 helper see()`)
  }
})
