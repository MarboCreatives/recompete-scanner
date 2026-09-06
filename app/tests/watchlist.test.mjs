// Watching and unwatching, driven over real HTTP against a running server.
//
// Every assertion about what was stored reads the row back from the database
// rather than believing the redirect, and every assertion about what a person
// sees reads the rendered page rather than the source file. A check that only
// followed the redirect would pass on a route that answered correctly and
// wrote nothing.
//
// Requires BASE_URL and a server on recompete_test, like the other flow checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { withDatabase, visibleText } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const SERVER_LOG = process.env.SERVER_LOG

const ALICE = 'alice@example.com'
const BOB = 'bob@example.com'

const CONTRACT = 'ic,C-2025-2026-Q1-00127'
const CONTRACT_2 = 'dnd-mdn,C-2025-2026-Q2-00112'
const VENDOR = 'lumina it'
const RECORD_URL = 'https://search.open.canada.ca/contracts/record/ic%2CC-2025-2026-Q1-00127'

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

async function getPage(path, cookie) {
  const r = await fetch(`${BASE}${path}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  })
  return { status: r.status, location: r.headers.get('location'), text: visibleText(await r.text()), raw: r }
}

/** A signed-in account, made directly so no email or token is involved. */
async function signIn(db, email) {
  const raw = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(raw).digest('hex')
  const user = await db.query(
    'insert into users (email, last_sign_in_at) values ($1, now()) returning id',
    [email],
  )
  const userId = user.rows[0].id
  await db.query(
    "insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '30 days')",
    [hash, userId],
  )
  return { cookie: `__Host-rs_session=${raw}`, userId }
}

async function watchRows(db, userId) {
  const r = await db.query(
    'select kind, target_key from watch_items where user_id = $1 order by kind, target_key',
    [userId],
  )
  return r.rows
}

test('watching a contract stores exactly the key that was asked for', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, ALICE)

    const r = await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })
    assert.equal(r.status, 303)
    assert.match(r.headers.get('location'), /\/watchlist$/)

    assert.deepEqual(await watchRows(db, userId), [{ kind: 'contract', target_key: CONTRACT }])
  })
})

test('pressing Watch twice leaves one row, not two and not an error', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, ALICE)
    await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })
    const second = await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })

    assert.equal(second.status, 303)
    assert.match(second.headers.get('location'), /\/watchlist$/, 'a repeat is not a failure')
    assert.equal((await watchRows(db, userId)).length, 1)
  })
})

test('a supplier and a contract are separate items even with the same text', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, ALICE)
    await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })
    await postForm('/watch/add', { kind: 'vendor', key: VENDOR }, { headers: { cookie } })

    assert.deepEqual(await watchRows(db, userId), [
      { kind: 'contract', target_key: CONTRACT },
      { kind: 'vendor', target_key: VENDOR },
    ])
  })
})

test('the watchlist shows both kinds and links each contract to the government record', async () => {
  await withDatabase(async (db) => {
    const { cookie } = await signIn(db, ALICE)
    await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })
    await postForm('/watch/add', { kind: 'vendor', key: VENDOR }, { headers: { cookie } })

    const page = await getPage('/watchlist', cookie)
    assert.equal(page.status, 200)
    assert.ok(page.text.includes('C-2025-2026-Q1-00127'), 'the reference number must be shown')
    assert.ok(page.text.includes('ic'), 'the department code must be shown')
    assert.ok(page.text.includes(VENDOR), 'the supplier key must be shown')
    assert.ok(page.text.includes('Contracts'), 'contracts have their own section')
    assert.ok(page.text.includes('Suppliers'), 'suppliers have their own section')

    // The address, exactly. A link to the wrong contract is worse than none:
    // the reader checks a row against the source and the source disagrees.
    const html = await (await fetch(`${BASE}/watchlist`, { headers: { cookie } })).text()
    assert.ok(html.includes(RECORD_URL), `the government record link must be ${RECORD_URL}`)
  })
})

test('unwatching removes the row and the empty state explains what to do', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, ALICE)
    await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })
    assert.equal((await watchRows(db, userId)).length, 1)

    const r = await postForm('/watch/remove', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })
    assert.equal(r.status, 303)
    assert.match(r.headers.get('location'), /\/watchlist$/)
    assert.equal((await watchRows(db, userId)).length, 0)

    const page = await getPage('/watchlist', cookie)
    assert.ok(page.text.includes('You are not watching anything yet.'))
    assert.ok(page.text.includes('Find a contract or a supplier on'))
    assert.ok(page.text.includes('recompeteradar.ca'))
    assert.ok(page.text.includes('press Watch'))
  })
})

test('unwatching something that is not on the list changes nothing and reports no error', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, ALICE)
    await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })

    const r = await postForm('/watch/remove', { kind: 'vendor', key: 'never watched' }, { headers: { cookie } })
    assert.equal(r.status, 303)
    assert.match(r.headers.get('location'), /\/watchlist$/)
    assert.equal((await watchRows(db, userId)).length, 1, 'the other item must survive')
  })
})

test('one person cannot remove or even see another person’s items', async () => {
  await withDatabase(async (db) => {
    const alice = await signIn(db, ALICE)
    const bob = await signIn(db, BOB)

    await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie: alice.cookie } })

    // Bob knows the key; the DELETE is scoped by user_id, so it is not his to remove.
    const attempt = await postForm(
      '/watch/remove',
      { kind: 'contract', key: CONTRACT },
      { headers: { cookie: bob.cookie } },
    )
    assert.equal(attempt.status, 303)
    assert.equal((await watchRows(db, alice.userId)).length, 1, "Alice's item must survive Bob's request")

    const bobPage = await getPage('/watchlist', bob.cookie)
    assert.ok(!bobPage.text.includes('C-2025-2026-Q1-00127'), "Bob must not see Alice's contract")
    assert.ok(bobPage.text.includes('You are not watching anything yet.'))
  })
})

test('a signed-out request stores nothing and is sent to sign in', async () => {
  await withDatabase(async (db) => {
    const r = await postForm('/watch/add', { kind: 'contract', key: CONTRACT })
    assert.equal(r.status, 303)
    assert.match(r.headers.get('location'), /\/sign-in$/)

    const n = await db.query('select count(*)::int as n from watch_items')
    assert.equal(n.rows[0].n, 0)
  })
})

test('a request with no Origin is forbidden and never reaches the database', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, ALICE)

    for (const path of ['/watch/add', '/watch/remove']) {
      const r = await fetch(`${BASE}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({ kind: 'contract', key: CONTRACT }),
      })
      assert.equal(r.status, 403, `${path} must refuse a request with no Origin`)
      assert.equal((await r.text()).trim(), 'Forbidden.')
    }

    for (const origin of ['https://evil.example', 'not a url', '']) {
      const r = await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie, origin } })
      assert.equal(r.status, 403, `origin ${JSON.stringify(origin)} must be refused`)
    }

    assert.equal((await watchRows(db, userId)).length, 0, 'no forbidden request may store anything')
  })
})

test('a key the pipeline could not have produced is refused and stored nowhere', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, ALICE)

    const refused = [
      { kind: 'contract', key: 'C-2025-2026-Q1-00127' },
      { kind: 'contract', key: 'ic,C-2025 2026' },
      { kind: 'vendor', key: 'Lumina IT' },
      { kind: 'vendor', key: 'a'.repeat(201) },
      { kind: 'supplier', key: VENDOR },
      { kind: 'contract' },
      { key: CONTRACT },
      {},
    ]
    for (const fields of refused) {
      const r = await postForm('/watch/add', fields, { headers: { cookie } })
      assert.equal(r.status, 303, `${JSON.stringify(fields)} should redirect`)
      assert.match(
        r.headers.get('location'),
        /problem=invalid/,
        `${JSON.stringify(fields)} should be refused as invalid`,
      )
    }

    assert.equal((await watchRows(db, userId)).length, 0, 'nothing refused may be stored')
  })
})

test('a repeated key parameter cannot be joined into a valid key', async () => {
  // The array case, end to end. Two separate key fields arrive as an array,
  // and a validator written for strings stringifies it to
  // "ic,C-2025-2026-Q1-00127", which is a key no single field ever carried.
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, ALICE)

    const body = new URLSearchParams()
    body.append('kind', 'contract')
    body.append('key', 'ic')
    body.append('key', 'C-2025-2026-Q1-00127')
    const r = await fetch(`${BASE}/watch/add`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
      body,
    })
    assert.equal(r.status, 303)
    assert.equal((await watchRows(db, userId)).length, 0, 'two key fields must not become one key')

    const page = await getPage('/watch?kind=contract&key=ic&key=C-2025-2026-Q1-00127', cookie)
    assert.ok(
      page.text.includes('That watch link is not valid.'),
      'a repeated key in the query string must not be joined either',
    )
  })
})

test('the watchlist is full at two hundred, and says so rather than failing', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, ALICE)
    await db.query(
      `insert into watch_items (user_id, kind, target_key)
       select $1, 'contract', 'ic,C-SEED-' || g from generate_series(1, 200) g`,
      [userId],
    )
    assert.equal((await watchRows(db, userId)).length, 200)

    const r = await postForm('/watch/add', { kind: 'contract', key: CONTRACT_2 }, { headers: { cookie } })
    assert.equal(r.status, 303)
    assert.match(r.headers.get('location'), /problem=full/)
    assert.equal((await watchRows(db, userId)).length, 200, 'the refused item must not be stored')

    const page = await getPage('/watchlist?problem=full', cookie)
    assert.ok(page.text.includes('Your watchlist is full at 200 items.'))
  })
})

test('the watch page offers to watch, and then offers to stop', async () => {
  await withDatabase(async (db) => {
    const { cookie } = await signIn(db, ALICE)

    const before = await getPage(`/watch?kind=contract&key=${encodeURIComponent(CONTRACT)}`, cookie)
    assert.equal(before.status, 200)
    assert.ok(before.text.includes('Watch this contract?'))
    assert.ok(before.text.includes('C-2025-2026-Q1-00127'), 'it must name the contract')
    assert.ok(before.text.includes('Department code ic'), 'the code is labelled, not printed bare')
    assert.ok(
      before.text.includes(
        'This saves it to your watchlist. Nothing is sent to you yet; alerts are not switched on in this release.',
      ),
      'it must say what happens next',
    )
    assert.ok(!before.text.includes('You are already watching this.'))

    await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })

    const after = await getPage(`/watch?kind=contract&key=${encodeURIComponent(CONTRACT)}`, cookie)
    assert.ok(after.text.includes('You are already watching this.'))
    assert.ok(after.text.includes('Stop watching'))
  })
})

test('the watch page for a supplier explains what the key is, and does not vouch for it', async () => {
  await withDatabase(async (db) => {
    const { cookie } = await signIn(db, ALICE)
    const page = await getPage(`/watch?kind=vendor&key=${encodeURIComponent(VENDOR)}`, cookie)

    assert.equal(page.status, 200)
    assert.ok(page.text.includes('Watch this supplier?'))
    assert.ok(page.text.includes(VENDOR))
    assert.ok(page.text.includes('This is a simplified form of the supplier name as published.'))
    // The page must not claim the text is the name as published; it is not.
    assert.ok(
      !page.text.includes('as it appears in the published records, normalised'),
      'the page must not claim the key is the published name',
    )
  })
})

test('an invalid watch link says so instead of asking anyone to sign in', async () => {
  // No cookie at all: the link is checked before the session, so a person is
  // not sent through sign-in only to be told the link was broken.
  const page = await getPage('/watch?kind=contract&key=nonsense')
  assert.equal(page.status, 200)
  assert.ok(page.text.includes('That watch link is not valid.'))
  assert.ok(page.text.includes('recompeteradar.ca'))

  const noParams = await getPage('/watch')
  assert.ok(noParams.text.includes('That watch link is not valid.'))
})

test('a valid watch link while signed out leads to sign in', async () => {
  const page = await getPage(`/watch?kind=contract&key=${encodeURIComponent(CONTRACT)}`)
  assert.ok([302, 303, 307].includes(page.status), `expected a redirect, got ${page.status}`)
  assert.match(page.location, /\/sign-in/)
})

test('the feed counts what is watched, with the right singular and plural', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, ALICE)

    const none = await getPage('/feed', cookie)
    assert.ok(none.text.includes('You are not watching anything yet.'), 'nought says so and says what to do')
    assert.ok(none.text.includes('press Watch'))
    assert.ok(!none.text.includes('You are watching'), 'nought must not print a count')

    await db.query(
      "insert into watch_items (user_id, kind, target_key) values ($1, 'contract', $2)",
      [userId, CONTRACT],
    )
    const one = await getPage('/feed', cookie)
    assert.ok(one.text.includes('You are watching 1 contract.'), `got: ${one.text.slice(0, 300)}`)

    await db.query(
      "insert into watch_items (user_id, kind, target_key) values ($1, 'contract', $2), ($1, 'vendor', $3)",
      [userId, CONTRACT_2, VENDOR],
    )
    const many = await getPage('/feed', cookie)
    assert.ok(many.text.includes('You are watching 2 contracts and 1 supplier.'))
    assert.ok(many.text.includes('Nothing has changed on them yet.'))

    // The caveat stays on the feed wherever it shows a date, in every state.
    assert.ok(many.text.includes('option years that are not published until they are exercised'))
    assert.ok(none.text.includes('option years that are not published until they are exercised'))
  })
})

test('each watchlist problem shows its own sentence and none of the others', async () => {
  await withDatabase(async (db) => {
    const { cookie } = await signIn(db, ALICE)
    const expected = {
      invalid: 'That watch request was not valid. Nothing was added.',
      full: 'Your watchlist is full at 200 items. Remove something before adding more.',
      add: 'That could not be saved just now. Nothing was changed. Try again in a few minutes.',
      remove: 'That could not be removed just now. Try again in a few minutes.',
    }
    for (const [problem, sentence] of Object.entries(expected)) {
      const page = await getPage(`/watchlist?problem=${problem}`, cookie)
      assert.ok(page.text.includes(sentence), `?problem=${problem} should say: ${sentence}`)
      for (const [other, otherSentence] of Object.entries(expected)) {
        if (other === problem) continue
        assert.ok(
          !page.text.includes(otherSentence),
          `?problem=${problem} must not also show the ${other} sentence`,
        )
      }
    }
    const plain = await getPage('/watchlist', cookie)
    for (const sentence of Object.values(expected)) {
      assert.ok(!plain.text.includes(sentence), `the plain watchlist must not show: ${sentence}`)
    }
  })
})

test('the privacy policy describes what a watchlist row actually holds', async () => {
  const page = await getPage('/privacy')
  assert.equal(page.status, 200)

  assert.ok(
    page.text.includes('stored as a simplified form of the supplier name'),
    'the policy must say a supplier is stored as a form of its name',
  )
  assert.ok(page.text.includes('the date you added each'))
  // The clause this replaced was false for suppliers: a vendor key is a
  // normalised name, so calling the whole watchlist reference codes was a
  // promise the code did not keep.
  assert.ok(
    !page.text.includes('stored as reference codes rather than names'),
    'the policy must not claim the watchlist holds no names',
  )
})

test('nothing about a watchlist reaches the server output', async () => {
  // A watchlist is personal data under MASTER-DESIGN rule 8. Neither an
  // address nor a key may be written down, and the routes log only an event
  // name. This reads the real captured output after every case above has run.
  assert.ok(SERVER_LOG, 'SERVER_LOG must name the captured server output')
  const text = readFileSync(SERVER_LOG, 'utf8')
  for (const secret of [ALICE, BOB, CONTRACT, VENDOR, 'C-2025-2026-Q1-00127']) {
    assert.ok(!text.includes(secret), `the server output contains ${secret}; the redaction is not holding`)
  }
  // Proof this check can find something: the events it is allowed to see.
  assert.ok(
    text.includes('watch_added') || text.includes('watch_removed'),
    'the run should have written at least one watch event, or this check proves nothing',
  )
})
