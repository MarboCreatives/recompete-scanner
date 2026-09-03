// Proves the token primitives produce values the database will accept, and that
// the digest is taken over the text rather than the bytes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { connectToTestDatabase, truncateAll } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { newToken, hashToken, isTokenShaped } = await import(
  pathToFileURL(join(here, '..', 'src', 'lib', 'tokens.ts')).href
)

test('a token is 43 base64url characters and never repeats', () => {
  const seen = new Set()
  for (let i = 0; i < 500; i += 1) {
    const t = newToken()
    assert.match(t, /^[A-Za-z0-9_-]{43}$/, `unexpected shape: ${t}`)
    assert.ok(!seen.has(t), 'two tokens collided, which should not happen in 500 draws')
    seen.add(t)
  }
})

test('the digest is over the 43-character text, not the 32 raw bytes', () => {
  // Anything seeding a row must hash the same way or it looks up nothing. The
  // expected value is computed here independently rather than by calling the
  // function twice.
  const raw = 'A'.repeat(43)
  const overText = createHash('sha256').update(raw).digest('hex')
  const overBytes = createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('hex')
  assert.equal(hashToken(raw), overText)
  assert.notEqual(hashToken(raw), overBytes, 'hashing the decoded bytes would be a different value')
})

test('a digest is 64 lowercase hex characters, which is what the column requires', () => {
  assert.match(hashToken(newToken()), /^[0-9a-f]{64}$/)
})

test('isTokenShaped accepts what newToken makes and refuses everything else', () => {
  assert.ok(isTokenShaped(newToken()))
  for (const bad of [
    '',
    'short',
    'A'.repeat(42),
    'A'.repeat(44),
    `${'A'.repeat(42)}+`, // + is base64, not base64url
    `${'A'.repeat(42)}/`,
    `${'A'.repeat(42)}=`,
    'A'.repeat(43) + ' ',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(isTokenShaped(bad), false, `should have refused ${JSON.stringify(String(bad))}`)
  }
})

test('a real token round-trips through the database columns', async () => {
  const client = await connectToTestDatabase()
  await truncateAll(client)

  const raw = newToken()
  const hash = hashToken(raw)
  await client.query(
    "insert into sign_in_tokens (token_hash, email, expires_at) values ($1, $2, now() + interval '15 minutes')",
    [hash, 'someone@example.com'],
  )

  // Looking a token up is done by digest, exactly as the application will.
  const found = await client.query('select email from sign_in_tokens where token_hash = $1', [
    hashToken(raw),
  ])
  assert.equal(found.rows.length, 1, 'the digest computed twice must find the row')
  assert.equal(found.rows[0].email, 'someone@example.com')

  await truncateAll(client)
  await client.end()
})

test('the database refuses a digest that is not 64 lowercase hex characters', async () => {
  const client = await connectToTestDatabase()
  await truncateAll(client)

  for (const bad of ['not-a-hash', 'A'.repeat(64), '0'.repeat(63), '0'.repeat(65)]) {
    await assert.rejects(
      () =>
        client.query(
          "insert into sign_in_tokens (token_hash, email, expires_at) values ($1, $2, now() + interval '15 minutes')",
          [bad, 'someone@example.com'],
        ),
      (err) => err?.code === '23514',
      `the column should have refused ${bad.slice(0, 20)}`,
    )
  }

  await truncateAll(client)
  await client.end()
})
