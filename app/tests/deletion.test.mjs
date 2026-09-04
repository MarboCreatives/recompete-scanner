// Proves that deleting an account deletes everything, and that the privacy
// policy says what the code actually does.
//
// The cascade test does not check a list of tables that I wrote down. It asks
// the database which tables carry a user_id, and requires every one of them to
// be empty of that user afterwards. A hand-written list would silently stop
// covering a table added in a later iteration, which is exactly when a
// forgotten cascade would go unnoticed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDatabase, visibleText } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const ADDRESS = 'someone@example.com'

async function postForm(path, fields, extra = {}) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE,
      ...(extra.headers ?? {}),
    },
    body: new URLSearchParams(fields),
  })
}

/**
 * Create a signed-in account with a row in every table that hangs off it, and
 * return the session cookie plus the user id.
 */
async function seedFullAccount(db) {
  const { randomBytes, createHash } = await import('node:crypto')
  const raw = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(raw).digest('hex')

  const user = await db.query(
    'insert into users (email, last_sign_in_at) values ($1, now()) returning id',
    [ADDRESS],
  )
  const userId = user.rows[0].id

  await db.query(
    "insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '30 days')",
    [hash, userId],
  )
  await db.query('insert into alert_preferences (user_id) values ($1)', [userId])
  await db.query(
    "insert into watch_items (user_id, kind, target_key) values ($1, 'contract', 'REF-1'), ($1, 'vendor', 'VEND-1')",
    [userId],
  )
  const ev = await db.query(
    `insert into events (event_type, contract_ref, dedupe_key, occurred_at)
     values ('EXPIRY_MOVED', 'REF-1', 'dedupe-1', now()) returning id`,
  )
  await db.query(
    "insert into event_deliveries (user_id, event_id, channel) values ($1, $2, 'feed')",
    [userId, ev.rows[0].id],
  )
  await db.query(
    "insert into sign_in_tokens (token_hash, email, expires_at) values ($1, $2, now() + interval '15 minutes')",
    [createHash('sha256').update(randomBytes(32).toString('base64url')).digest('hex'), ADDRESS],
  )

  return { cookie: `__Host-rs_session=${raw}`, userId, eventId: ev.rows[0].id }
}

/** Every table with a user_id column, asked of the database rather than listed. */
async function tablesReferencingUsers(db) {
  const r = await db.query(`
    select table_name from information_schema.columns
     where table_schema = 'public' and column_name = 'user_id'
     order by table_name
  `)
  return r.rows.map((row) => row.table_name)
}

test('deleting an account removes every row that describes the person', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await seedFullAccount(db)

    const tables = await tablesReferencingUsers(db)
    assert.ok(tables.length >= 4, `expected several user tables, found ${tables.join(', ')}`)

    // Everything is present before the delete, so the assertions afterwards mean
    // something. A test that deletes nothing and then finds nothing passes for
    // the wrong reason.
    for (const table of tables) {
      const before = await db.query(
        `select count(*)::int as n from ${table} where user_id = $1`,
        [userId],
      )
      assert.ok(before.rows[0].n > 0, `${table} should have a row before the delete`)
    }
    const tokensBefore = await db.query(
      'select count(*)::int as n from sign_in_tokens where email = $1',
      [ADDRESS],
    )
    assert.equal(tokensBefore.rows[0].n, 1, 'a pending sign-in link should exist before')

    const r = await postForm('/account/delete', { confirm: 'yes' }, { headers: { cookie } })
    assert.equal(r.status, 303)
    assert.match(r.headers.get('location'), /\/deleted$/)

    // The user row itself.
    const user = await db.query('select count(*)::int as n from users where id = $1', [userId])
    assert.equal(user.rows[0].n, 0, 'the user row must be gone')

    // Every table the database says references a user.
    for (const table of tables) {
      const after = await db.query(
        `select count(*)::int as n from ${table} where user_id = $1`,
        [userId],
      )
      assert.equal(after.rows[0].n, 0, `${table} still holds a row for the deleted user`)
    }

    // Pending sign-in links are keyed by address, not user id, so they need
    // their own statement and their own assertion.
    const tokensAfter = await db.query(
      'select count(*)::int as n from sign_in_tokens where email = $1',
      [ADDRESS],
    )
    assert.equal(tokensAfter.rows[0].n, 0, 'a pending sign-in link must not survive deletion')

    // Nothing anywhere still holds the address.
    const anyUser = await db.query('select count(*)::int as n from users where email = $1', [
      ADDRESS,
    ])
    assert.equal(anyUser.rows[0].n, 0)
  })
})

test('the shared event survives, because it is not personal data', async () => {
  await withDatabase(async (db) => {
    const { cookie, eventId } = await seedFullAccount(db)
    await postForm('/account/delete', { confirm: 'yes' }, { headers: { cookie } })

    const ev = await db.query('select count(*)::int as n from events where id = $1', [eventId])
    assert.equal(
      ev.rows[0].n,
      1,
      'an event is a fact about a contract, shared by everyone watching it; ' +
        'deleting one person must not remove it for the others',
    )
  })
})

test('the session cookie stops working the moment the account is deleted', async () => {
  await withDatabase(async (db) => {
    const { cookie } = await seedFullAccount(db)

    const before = await fetch(`${BASE}/feed`, { headers: { cookie }, redirect: 'manual' })
    assert.equal(before.status, 200, 'the seeded session should work before the delete')

    await postForm('/account/delete', { confirm: 'yes' }, { headers: { cookie } })

    const after = await fetch(`${BASE}/feed`, { headers: { cookie }, redirect: 'manual' })
    assert.ok([302, 303, 307].includes(after.status), `expected a redirect, got ${after.status}`)
    assert.match(after.headers.get('location'), /\/sign-in/)
  })
})

test('deletion also sends a cookie-clearing header that a browser will honour', async () => {
  // This exists because breaking it on purpose broke nothing. Access is already
  // refused after deletion, because the session row goes with the user row, so
  // the test above passes whether or not the cookie is cleared.
  //
  // Clearing it is still worth doing: without it the browser keeps sending a
  // value that matches nothing, on every request, until it expires 30 days
  // later. But a line with no check behind it is a line the next person deletes,
  // reasonably, because nothing tells them it matters. So the header is
  // asserted directly.
  //
  // Secure and Path=/ are asserted, not merely the presence of a Set-Cookie: a
  // `__Host-` cookie without Secure is ignored by the browser, which is how the
  // obvious one-line way of clearing it silently fails.
  await withDatabase(async (db) => {
    const { cookie } = await seedFullAccount(db)

    const r = await postForm('/account/delete', { confirm: 'yes' }, { headers: { cookie } })
    const clearing = r.headers.get('set-cookie')

    assert.ok(clearing, 'deletion must send a clearing cookie')
    assert.match(clearing, /__Host-rs_session=/)
    assert.match(clearing, /Secure/, 'without Secure a browser ignores it for a __Host- cookie')
    assert.match(clearing, /Path=\//)
    assert.doesNotMatch(clearing, /Domain=/, '__Host- cookies must carry no Domain')
    assert.match(
      clearing,
      /Max-Age=0|Expires=/,
      'it must actually expire the cookie rather than reset it',
    )
  })
})

test('deletion without ticking the box changes nothing', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await seedFullAccount(db)

    const r = await postForm('/account/delete', {}, { headers: { cookie } })
    assert.equal(r.status, 303)
    assert.match(r.headers.get('location'), /problem=confirm/)

    const user = await db.query('select count(*)::int as n from users where id = $1', [userId])
    assert.equal(user.rows[0].n, 1, 'an unconfirmed request must not delete the account')

    // And the page it lands on says why.
    const page = visibleText(await (await fetch(`${BASE}/account?problem=confirm`, {
      headers: { cookie },
    })).text())
    assert.ok(page.includes('Tick the box to confirm before pressing Delete account.'))
  })
})

test('a signed-out or forged deletion request deletes nothing', async () => {
  await withDatabase(async (db) => {
    const { userId } = await seedFullAccount(db)

    // No cookie at all.
    const anon = await postForm('/account/delete', { confirm: 'yes' })
    assert.equal(anon.status, 303)
    assert.match(anon.headers.get('location'), /\/sign-in$/)

    // No Origin header.
    const forged = await fetch(`${BASE}/account/delete`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ confirm: 'yes' }),
    })
    assert.equal(forged.status, 403)

    const user = await db.query('select count(*)::int as n from users where id = $1', [userId])
    assert.equal(user.rows[0].n, 1, 'neither request may delete anything')
  })
})

test('the deleted page states both things we cannot reach', async () => {
  const text = visibleText(await (await fetch(`${BASE}/deleted`)).text())
  assert.ok(text.includes('Your account, sessions, watchlist and preferences have been removed.'))
  assert.ok(text.includes('Resend keeps a copy of the sign-in emails already sent to you'))
  assert.ok(text.includes('deletes it within 30 days'))
  assert.ok(text.includes('short-term point-in-time backups'))
})

test('the privacy policy carries the legal details and the cross-border disclosure', async () => {
  const r = await fetch(`${BASE}/privacy`)
  assert.equal(r.status, 200)
  const text = visibleText(await r.text())

  // CASL requires the business name and a mailing address; PIPEDA requires a
  // way to reach us. These are the real ones, taken from recompeteradar.ca.
  assert.ok(text.includes('Canadian Recompete Radar'), 'the business name must appear')
  assert.ok(
    text.includes('PO Box 1184, Pembroke, Ontario K8A 6Y6'),
    'the mailing address must appear',
  )
  assert.ok(text.includes('hello@recompeteradar.ca'), 'a contact address must appear')

  // Storing personal data outside Canada has to be disclosed, and the reason
  // given plainly rather than buried.
  assert.ok(text.includes('In the United States'), 'where the data lives must be stated')
  assert.ok(
    text.includes('subject to United States law'),
    'the consequence of storing it there must be stated',
  )

  // Claims the code actually keeps.
  assert.ok(text.includes('No password.'))
  assert.ok(text.includes('No IP address'))
  assert.ok(text.includes('usable for 15 minutes'))
  assert.ok(text.includes('Sessions: 30 days'))
  assert.ok(text.includes('Rows are deleted, not hidden'))
  assert.ok(text.includes('PIPEDA'))
  assert.ok(text.includes('CASL'))
})

test('the privacy policy is reachable without signing in', async () => {
  // It has to be readable before someone decides whether to create an account.
  const r = await fetch(`${BASE}/privacy`, { redirect: 'manual' })
  assert.equal(r.status, 200, 'the policy must not require a session')

  const home = visibleText(await (await fetch(`${BASE}/`)).text())
  assert.ok(
    home.includes('What we store, and how to delete it'),
    'the home page must link to it',
  )
})
