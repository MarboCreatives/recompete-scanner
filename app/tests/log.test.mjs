// Proves the logger cannot write an email address.
//
// The oracle here is independent of the code under test. The error objects fed
// in below are hand-built from what the live database actually returned on
// 2 September 2026, recorded at the time:
//
//     detail: "Key (email)=(someone@example.com) already exists."
//     detail: "Failing row contains (3, MiXeD@example.com)."
//     fields: message, code, detail, hint, position, internalPosition,
//             internalQuery, severity, where, table, column, schema, dataType,
//             constraint, file, line, routine
//
// The test does not ask the logger what it considers sensitive; it asserts on a
// string the test itself owns. That is the rule the main site learned the hard
// way when its suppression audit called the function it was validating.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// A bare Windows absolute path is not a legal module specifier; Node rejects it
// with ERR_UNSUPPORTED_ESM_URL_SCHEME because it reads "C:" as a protocol.
const here = dirname(fileURLToPath(import.meta.url))
const logModule = pathToFileURL(join(here, '..', 'src', 'lib', 'log.ts')).href
const { log, errorFacts } = await import(logModule)

/** Capture everything the logger writes during one call. */
function capture(fn) {
  const written = []
  const original = console.log
  console.log = (...args) => written.push(args.join(' '))
  try {
    fn()
  } finally {
    console.log = original
  }
  return written.join('\n')
}

const ADDRESS = 'someone@example.com'

test('an allowlisted field survives', () => {
  const out = capture(() => log({ event: 'sign_in_requested', code: '23505' }))
  assert.match(out, /sign_in_requested/)
  assert.match(out, /23505/)
})

test('a field that is not on the allowlist is dropped entirely', () => {
  const out = capture(() => log({ event: 'x', email: ADDRESS, userId: 'abc-123' }))
  assert.doesNotMatch(out, /example\.com/)
  assert.doesNotMatch(out, /abc-123/)
  assert.doesNotMatch(out, /userId/)
  assert.match(out, /"event":"x"/)
})

test('an allowlisted field carrying an address is dropped, not masked', () => {
  // `reason` is allowlisted, so only the at-sign rule can stop this.
  const out = capture(() => log({ event: 'x', reason: `rejected ${ADDRESS}` }))
  assert.doesNotMatch(out, /example\.com/)
  assert.doesNotMatch(out, /someone/)
  assert.doesNotMatch(out, /reason/, 'the key should disappear rather than hold a placeholder')
})

test('a long value is truncated to 200 characters', () => {
  const long = 'a'.repeat(500)
  const out = capture(() => log({ event: 'x', reason: long }))
  const parsed = JSON.parse(out)
  assert.equal(parsed.reason.length, 200)
})

test('an object value is dropped, so a nested address cannot ride in', () => {
  const out = capture(() => log({ event: 'x', reason: { nested: ADDRESS } }))
  assert.doesNotMatch(out, /example\.com/)
  assert.doesNotMatch(out, /nested/)
})

test('errorFacts keeps only the code and the constraint', () => {
  // Hand-built from the observed shape of a real unique violation.
  const observed = {
    message: `duplicate key value violates unique constraint "users_email_unique"`,
    code: '23505',
    detail: `Key (email)=(${ADDRESS}) already exists.`,
    hint: undefined,
    where: `insert into users`,
    severity: 'ERROR',
    table: 'users',
    column: 'email',
    schema: 'public',
    constraint: 'users_email_unique',
    file: 'nbtinsert.c',
    line: '666',
    routine: '_bt_check_unique',
  }
  const facts = errorFacts(observed)
  assert.deepEqual(facts, { code: '23505', constraint: 'users_email_unique' })
  assert.equal(Object.keys(facts).length, 2, 'no other field may survive')
})

test('a check violation carrying the row value yields nothing but the code', () => {
  const observed = {
    message: 'new row for relation "users" violates check constraint "users_email_normalised"',
    code: '23514',
    detail: 'Failing row contains (3, MiXeD@example.com).',
    constraint: 'users_email_normalised',
  }
  const facts = errorFacts(observed)
  assert.equal(facts.code, '23514')
  assert.equal(facts.constraint, 'users_email_normalised')
  assert.doesNotMatch(JSON.stringify(facts), /example\.com/)
})

test('the whole path holds: a real error shape logged writes no address', () => {
  const observed = {
    message: `duplicate key value violates unique constraint "users_email_unique"`,
    code: '23505',
    detail: `Key (email)=(${ADDRESS}) already exists.`,
    constraint: 'users_email_unique',
  }
  const out = capture(() => log({ event: 'sign_in_failed', ...errorFacts(observed) }))
  assert.doesNotMatch(out, /example\.com/)
  assert.doesNotMatch(out, /someone/)
  assert.match(out, /23505/)
  assert.match(out, /users_email_unique/)
})

test('a code that is not a SQLSTATE is refused rather than passed through', () => {
  // Guards against an error whose `code` is a sentence or a path, which some
  // libraries do. A SQLSTATE is exactly five alphanumeric characters.
  assert.deepEqual(errorFacts({ code: `contains ${ADDRESS}` }), {}, 'a sentence is not a code')
  assert.deepEqual(errorFacts({ code: 'ENOENT' }), {}, 'six characters is not a SQLSTATE')
  assert.deepEqual(errorFacts({ code: '23505' }), { code: '23505' }, 'five characters is')
})

test('a non-object throw does not crash the reduction', () => {
  assert.deepEqual(errorFacts(undefined), {})
  assert.deepEqual(errorFacts(null), {})
  assert.deepEqual(errorFacts(`a string mentioning ${ADDRESS}`), {})
})
