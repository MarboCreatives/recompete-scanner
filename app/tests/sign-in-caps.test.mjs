// The two rate caps on sign-in links, and the boundary of each.
//
// Neither had a check until 7 September 2026. `AUDIT-2026-09-06.md` recorded
// that as a gap, and it stayed a gap while the global cap was raised from 20 to
// 60 for four testers — which is exactly the moment a security control should
// stop being taken on trust.
//
// The rows are seeded straight into `sign_in_tokens` rather than driven through
// sixty HTTP requests. That is not a shortcut around the thing under test: the
// route counts rows in that table and nothing else, so a seeded row and a
// requested one are the same input to it. It also keeps the check honest about
// what it proves — the counting and the boundary, not the inserting.
//
// Both caps are tested at the boundary in both directions. A cap tested only
// from above cannot tell 60 from 6.
//
// Requires BASE_URL and a running server.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDatabase } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

// Written out here rather than imported from the route, because a check that
// asks the code under test what the right answer is cannot notice the code
// being wrong. CODING-STANDARDS 2.4. If these two numbers stop matching
// src/app/auth/request/route.ts, one of the two is a mistake and this is the
// check that says so.
const PER_ADDRESS_HOURLY_CAP = 5
const GLOBAL_HOURLY_CAP = 60

async function askForLink(email) {
  return fetch(`${BASE}/auth/request`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
    body: new URLSearchParams({ email }),
  })
}

/** Where a 303 points, ignoring the origin see() puts in front of it. */
function problem(response) {
  const location = response.headers.get('location')
  assert.ok(location, 'no Location header')
  return new URL(location, BASE).searchParams.get('problem')
}

/** n token rows, each a different address, all inside the counting window. */
async function seedTokens(db, n, email = null) {
  for (let i = 0; i < n; i++) {
    await db.query(
      `insert into sign_in_tokens (token_hash, email, expires_at, created_at)
       values ($1, $2, now() + interval '15 minutes', now())`,
      [`${i}`.padStart(64, 'f'), email ?? `seeded-${i}@example.com`],
    )
  }
}

test('one address is refused a sixth link in an hour, and allowed a fifth', async () => {
  await withDatabase(async (db) => {
    const email = 'capped@example.com'

    await seedTokens(db, PER_ADDRESS_HOURLY_CAP - 1, email)
    const allowed = await askForLink(email)
    assert.equal(allowed.status, 303)
    assert.notEqual(
      problem(allowed),
      'too-many',
      `the ${PER_ADDRESS_HOURLY_CAP}th link of the hour must still be sent`,
    )

    // That request inserted a row of its own, so the address is now at the cap.
    const refused = await askForLink(email)
    assert.equal(refused.status, 303)
    assert.equal(problem(refused), 'too-many')
  })
})

test('the per-address cap counts one address, not everybody', async () => {
  await withDatabase(async (db) => {
    await seedTokens(db, PER_ADDRESS_HOURLY_CAP + 3, 'noisy@example.com')
    const other = await askForLink('quiet@example.com')
    assert.equal(other.status, 303)
    assert.notEqual(problem(other), 'too-many', 'one loud address must not silence another')
  })
})

test('the whole site is refused past sixty links in an hour, and allowed below it', async () => {
  await withDatabase(async (db) => {
    await seedTokens(db, GLOBAL_HOURLY_CAP - 1)
    const allowed = await askForLink('under-the-line@example.com')
    assert.equal(allowed.status, 303)
    assert.notEqual(
      problem(allowed),
      'busy',
      `link ${GLOBAL_HOURLY_CAP} of the hour must still be sent`,
    )

    const refused = await askForLink('over-the-line@example.com')
    assert.equal(refused.status, 303)
    assert.equal(problem(refused), 'busy')
  })
})

test('the cap is sixty, not twenty; four testers at five links each do not close the site', async () => {
  // The reason the number changed. Twenty is what four people asking for five
  // links each comes to exactly, and a failed send charges the cap, so one
  // fumbled link would have closed sign-in for everyone including Jon.
  await withDatabase(async (db) => {
    await seedTokens(db, 4 * PER_ADDRESS_HOURLY_CAP)
    const fifth = await askForLink('the-owner@example.com')
    assert.equal(fifth.status, 303)
    assert.notEqual(
      problem(fifth),
      'busy',
      'twenty links in an hour must not close the site to anyone else',
    )
  })
})

test('an expired row outside the window does not hold the cap down', async () => {
  // The route deletes expired rows before counting, with an hour of grace so a
  // failed send is still charged. A row older than that must not count.
  //
  // Worth knowing what this can and cannot tell apart. Old rows are excluded
  // TWICE: the sweep deletes them, and the counting window ignores them by
  // `created_at`. Breaking either one alone leaves this passing, which the break
  // harness reported as NOT CAUGHT before the break was rewritten to remove
  // both. That is not a vacuous check — the outcome is real and it is what a
  // person experiences — but a single-mechanism regression here would be caught
  // by neither this nor anything else, and that is worth saying out loud rather
  // than leaving for someone to rediscover.
  await withDatabase(async (db) => {
    // expires_at must be after created_at: sign_in_tokens_expiry. The first
    // version of this seed set both to the same instant and the database
    // refused it, which is the constraint doing its job on a row shaped
    // unlike anything the application would write. A link issued three hours
    // ago and good for fifteen minutes is the real shape.
    for (let i = 0; i < GLOBAL_HOURLY_CAP + 10; i++) {
      await db.query(
        `insert into sign_in_tokens (token_hash, email, expires_at, created_at)
         values ($1, $2, now() - interval '3 hours' + interval '15 minutes',
                 now() - interval '3 hours')`,
        [`${i}`.padStart(64, 'e'), `old-${i}@example.com`],
      )
    }
    const fresh = await askForLink('today@example.com')
    assert.equal(fresh.status, 303)
    assert.notEqual(problem(fresh), 'busy', 'yesterday must not close the site today')
  })
})
