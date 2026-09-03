// Proves normalizeEmail and the database agree on exactly which addresses exist.
//
// This is the highest-value check in the suite, because disagreement between
// them is not a cosmetic bug. If the function is the more permissive of the two,
// a person is issued a sign-in link, emailed it, and then rejected when the
// account row is written, after the link has already been spent. They can repeat
// that for ever and never get in, and nothing on screen explains why. That fault
// was found on 2 September 2026, when the then-current regex accepted `abc@d.e`
// and the constraint rejected it.
//
// The oracle here is the live constraint itself, which is genuinely independent
// of the JavaScript: it is DDL in a migration file, enforced by Postgres. The
// test does not ask normalizeEmail whether it is right; it asks the database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { connectToTestDatabase, truncateAll } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { normalizeEmail } = await import(
  pathToFileURL(join(here, '..', 'src', 'lib', 'normalize-email.ts')).href
)

/** Addresses chosen to sit either side of every boundary in the two rules. */
const CORPUS = [
  // The three measured on 2 September 2026 against the live constraint.
  'abc@d.e',
  'a@b.c',
  'ab@c.de',
  // Ordinary.
  'jon@recompeteradar.ca',
  'someone@example.com',
  'a.b+tag@sub.example.co.uk',
  // Length boundaries: the constraint requires 6 to 254 characters.
  'a@b.c',
  'a@b.cd',
  'ab@c.de',
  `${'a'.repeat(240)}@example.com`,
  `${'a'.repeat(250)}@example.com`,
  // Characters after the final dot: one versus two.
  'user@example.a',
  'user@example.ab',
  // Missing pieces.
  '@example.com',
  'user@',
  'user@.com',
  'userexample.com',
  'user@example',
  'user@@example.com',
  // Whitespace and case, which normalising is supposed to handle.
  '  Jon@Example.COM  ',
  'JON@EXAMPLE.COM',
  'jon @example.com',
  'jon@ example.com',
  'jon@example.com ',
  // Dots in awkward places.
  '.jon@example.com',
  'jon.@example.com',
  'jon@example..com',
  'jon@.example.com',
  // Not strings, or empty.
  '',
  '     ',
  'a@b',
  'ab@cd',
]

/** Ask the database, and only the database, whether it will store this. */
async function databaseAccepts(client, address) {
  try {
    await client.query('insert into users (email) values ($1)', [address])
    await client.query('delete from users where email = $1', [address])
    return true
  } catch (err) {
    // 23514 is check_violation, 23505 is unique_violation. Only the first means
    // the address was refused on its shape.
    if (err?.code === '23514') return false
    if (err?.code === '23505') return true
    throw err
  }
}

test('every address normalizeEmail accepts is one the database will store', async () => {
  const client = await connectToTestDatabase()
  await truncateAll(client)

  const disagreements = []
  for (const input of CORPUS) {
    const normalised = normalizeEmail(input)
    if (normalised === null) continue
    const accepted = await databaseAccepts(client, normalised)
    if (!accepted) {
      disagreements.push(
        `normalizeEmail(${JSON.stringify(input)}) returned ` +
          `${JSON.stringify(normalised)}, which the database refuses. ` +
          'A person typing this is emailed a link and then locked out.',
      )
    }
  }

  await truncateAll(client)
  await client.end()
  assert.deepEqual(disagreements, [], disagreements.join('\n'))
})

test('normalizeEmail is not needlessly stricter than the database', async () => {
  // The other direction is not a lockout, only an address turned away for no
  // reason. Worth knowing about, so it is asserted rather than assumed.
  const client = await connectToTestDatabase()
  await truncateAll(client)

  const overStrict = []
  for (const input of CORPUS) {
    if (typeof input !== 'string') continue
    const alreadyNormal = input.trim().toLowerCase()
    if (alreadyNormal !== input) continue // only compare like with like
    if (normalizeEmail(input) !== null) continue
    const accepted = await databaseAccepts(client, input)
    if (accepted) {
      overStrict.push(
        `the database would store ${JSON.stringify(input)} but normalizeEmail refuses it`,
      )
    }
  }

  await truncateAll(client)
  await client.end()
  assert.deepEqual(overStrict, [], overStrict.join('\n'))
})

test('the three addresses measured against the live constraint behave as recorded', async () => {
  // Pinning the specific finding, so a future change to the regex that
  // reintroduces it fails here with a name attached.
  assert.equal(normalizeEmail('abc@d.e'), null, 'one character after the final dot is refused')
  assert.equal(normalizeEmail('a@b.c'), null, 'too short and one character after the dot')
  assert.equal(normalizeEmail('ab@c.de'), 'ab@c.de', 'two characters after the dot is accepted')
})

test('normalising lowercases and trims, so the stored form is the canonical one', () => {
  assert.equal(normalizeEmail('  Jon@Example.COM  '), 'jon@example.com')
  assert.equal(normalizeEmail('JON@EXAMPLE.COM'), 'jon@example.com')
})

test('anything that is not a string is refused rather than coerced', () => {
  for (const value of [undefined, null, 42, {}, [], true, Symbol('x')]) {
    assert.equal(normalizeEmail(value), null, `${String(value)} must not become an address`)
  }
})
