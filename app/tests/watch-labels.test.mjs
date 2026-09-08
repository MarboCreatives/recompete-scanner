// The caption on a watched contract: the supplier name and the department.
//
// Before this existed a watched contract row read only:
//
//     C-2025-2026-Q4-00435
//     Department nrc-cnrc - added 2026-09-07
//
// which names the contract exactly and tells the reader nothing. The public
// site now puts the supplier name and the department name on the Watch link as
// `&name=` and `&dept=`, and this application stores what arrives.
//
// Three properties are worth more than the happy path, and most of this file is
// about them:
//
//   * A caption is CALLER-CONTROLLED. It arrives in a URL, so it is capped,
//     stripped of anything that could disguise what a row says, and escaped on
//     output. The check for U+202E is not decoration: that character reverses
//     everything printed after it.
//   * A caption is NEVER identity. Nothing is looked up, joined or grouped by
//     it. The key remains the only identity, which is why a caption cannot
//     smuggle a second `key` into an address.
//   * A caption is OPTIONAL and always was. Every row saved before
//     0003_watch_labels.sql has none, and a link can arrive without one. Those
//     rows get a sentence, not a blank line, and pressing Watch again is how
//     they acquire a caption.
//
// The database checks require a server on recompete_test; the parser checks run
// anywhere. The journey check additionally needs SERVER_LOG.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { withDatabase, visibleText } from './helpers.mjs'
import { installTypeScriptResolver, libUrl } from './ts-resolve.mjs'

installTypeScriptResolver()
const { parseWatchLabels, watchPath, withWatchTarget, MAX_LABEL_LENGTH, NO_CONTRACT_LABEL_NOTE } =
  await import(libUrl('watch.ts'))

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const SERVER_LOG = process.env.SERVER_LOG

// One address per case: the per-address cap is five links an hour, and a shared
// address would make a later case fail for a reason that is not its own.
const ALICE = 'labelled-alice@example.com'
const BOB = 'labelled-bob@example.com'
const CAROL = 'labelled-carol@example.com'
const DAVE = 'labelled-dave@example.com'
const JOURNEY = 'labelled-journey@example.com'

const CONTRACT = 'nrc-cnrc,C-2025-2026-Q4-00435'
const NAME = 'Skyalyne Canada Inc.'
const DEPT = 'National Research Council Canada'
const TARGET = { kind: 'contract', key: CONTRACT }

// --- the parser, on its own -------------------------------------------------

test('a contract carries a caption; a supplier cannot', () => {
  assert.deepEqual(parseWatchLabels('contract', NAME, DEPT), { name: NAME, dept: DEPT })

  // A supplier is identified by its vendor_key, which already IS the display
  // name. A second name for it could only ever disagree with the first, so the
  // parser refuses one whatever the caller passes.
  assert.deepEqual(parseWatchLabels('vendor', NAME, DEPT), { name: null, dept: null })
  assert.deepEqual(parseWatchLabels('nonsense', NAME, DEPT), { name: null, dept: null })
})

test('anything that is not a usable string is absent rather than an error', () => {
  // A repeated query parameter arrives as an array in this framework, and
  // FormData.get can return a File. Neither is a caption; neither may throw.
  for (const bad of [undefined, null, 42, {}, [NAME, 'other'], '', '   ', '\n\t ']) {
    assert.deepEqual(
      parseWatchLabels('contract', bad, bad),
      { name: null, dept: null },
      `${JSON.stringify(bad)} must be absent, not an error`,
    )
  }
})

test('a caption cannot break the line it sits on, or reverse it', () => {
  // Newlines and tabs collapse, so a caption stays one line.
  assert.equal(parseWatchLabels('contract', 'Sky\nalyne\tInc', null).name, 'Sky alyne Inc')

  // U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed after it, so a
  // caption carrying one could make a row read as a supplier it is not.
  const reversed = parseWatchLabels('contract', 'Acme\u202E Ltd', null).name
  assert.ok(!reversed.includes('\u202E'), 'a direction override must not survive')

  // Zero-width characters are the same problem more quietly.
  assert.ok(!parseWatchLabels('contract', 'Ac\u200Bme', null).name.includes('\u200B'))
})

test('the cap is the database constraint, and never cuts a character in half', () => {
  const long = parseWatchLabels('contract', 'a'.repeat(MAX_LABEL_LENGTH + 50), null).name
  assert.equal(long.length, MAX_LABEL_LENGTH)

  // Slicing at a fixed number of UTF-16 units can split a surrogate pair, and
  // Postgres refuses a lone surrogate as an invalid byte sequence: that would
  // be a 500 on insert rather than a shortened caption.
  //
  // The single leading 'a' is the whole point of this case. Without it the
  // emoji start at unit 0, the cut at 200 falls between two pairs, every pair
  // stays whole, and this check passes whether or not the code removes a split
  // surrogate — it could not fail. break-labels.py caught exactly that on
  // 7 September 2026. The odd offset makes the cut land inside a pair.
  const emoji = parseWatchLabels('contract', 'a' + '\u{1F600}'.repeat(150), null).name
  const unpaired = emoji.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
  assert.ok(!/[\uD800-\uDFFF]/.test(unpaired), 'a lone surrogate must never be stored')
  assert.ok(emoji.length <= MAX_LABEL_LENGTH)
})

// --- the caption on an address ----------------------------------------------

test('a caption rides on the address, and an absent one adds nothing', () => {
  const q = new URL(watchPath(TARGET, { name: NAME, dept: DEPT }), BASE).searchParams
  assert.equal(q.get('kind'), 'contract')
  assert.equal(q.get('key'), CONTRACT)
  assert.equal(q.get('name'), NAME)
  assert.equal(q.get('dept'), DEPT)

  // The default is no caption, which is what every caller passed before
  // captions existed.
  assert.equal(watchPath(TARGET), `/watch?kind=contract&key=${encodeURIComponent(CONTRACT)}`)
  assert.equal(
    withWatchTarget('/sign-in', TARGET, { name: null, dept: null }),
    `/sign-in?kind=contract&key=${encodeURIComponent(CONTRACT)}`,
  )

  // The contract-only rule holds on the way out too, not only on the way in.
  assert.equal(
    withWatchTarget('/sign-in', { kind: 'vendor', key: 'skyalyne' }, { name: NAME, dept: DEPT }),
    '/sign-in?kind=vendor&key=skyalyne',
  )
})

test('a caption cannot smuggle a second parameter into the address', () => {
  // If the caption were written out unencoded, this would append its own `key`
  // and the address would name a different contract than the one identified.
  const hostile = 'Acme&key=evil,C-0000-0000-Q1-00000&next=https://evil.example'
  const url = new URL(watchPath(TARGET, { name: hostile, dept: null }), BASE)
  assert.equal(url.searchParams.getAll('key').length, 1, 'exactly one key survives')
  assert.equal(url.searchParams.get('key'), CONTRACT, 'and it is the real one')
  assert.equal(url.searchParams.get('next'), null, 'nothing else got in')
  assert.equal(url.pathname, '/watch')
})

// --- the database -----------------------------------------------------------

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
  const r = await fetch(`${BASE}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} })
  return { status: r.status, location: r.headers.get('location'), text: visibleText(await r.text()) }
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

async function labelsOf(db, userId) {
  const r = await db.query(
    'select target_key, label_name, label_dept from watch_items where user_id = $1',
    [userId],
  )
  return r.rows
}

test('MAX_LABEL_LENGTH is what the database enforces, not a hope', async () => {
  await withDatabase(async (db) => {
    const { userId } = await signIn(db, ALICE)
    const insert = (label) =>
      db.query(
        'insert into watch_items (user_id, kind, target_key, label_name) values ($1, $2, $3, $4)',
        [userId, 'contract', `nrc-cnrc,C-${label.length}`, label],
      )

    // Exactly the cap is accepted...
    await insert('a'.repeat(MAX_LABEL_LENGTH))

    // ...and one character more is refused by the database itself. If this
    // stops failing, the constraint and MAX_LABEL_LENGTH have drifted apart and
    // the parser is the only thing between a URL and a 500.
    await assert.rejects(
      () => insert('a'.repeat(MAX_LABEL_LENGTH + 1)),
      /watch_items_label_name_len|violates check constraint/i,
    )
  })
})

test('the database refuses a caption on a supplier row', async () => {
  await withDatabase(async (db) => {
    const { userId } = await signIn(db, BOB)
    await assert.rejects(
      () =>
        db.query(
          'insert into watch_items (user_id, kind, target_key, label_name) values ($1, $2, $3, $4)',
          [userId, 'vendor', 'skyalyne', NAME],
        ),
      /watch_items_labels_are_contract_only|violates check constraint/i,
      'the contract-only rule must live in the database, not only in the parser',
    )
  })
})

// --- what a person sees -----------------------------------------------------

test('a captioned contract says who the supplier is, above the reference number', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, CAROL)

    const added = await postForm(
      '/watch/add',
      { kind: 'contract', key: CONTRACT, name: NAME, dept: DEPT },
      { headers: { cookie } },
    )
    assert.equal(added.status, 303)

    // Read back from the database rather than believed from the redirect.
    assert.deepEqual(await labelsOf(db, userId), [
      { target_key: CONTRACT, label_name: NAME, label_dept: DEPT },
    ])

    const page = await getPage('/watchlist', cookie)
    assert.match(page.text, /Skyalyne Canada Inc\./, 'the supplier name must be on the row')
    assert.match(page.text, /C-2025-2026-Q4-00435/, 'the reference number stays')
    assert.match(page.text, /National Research Council Canada/, 'the department name is shown')
    assert.match(page.text, /nrc-cnrc/, 'and the department code stays beside it')

    // The name comes first, because it is the thing anybody recognises.
    assert.ok(
      page.text.indexOf('Skyalyne Canada Inc.') < page.text.indexOf('C-2025-2026-Q4-00435'),
      'the supplier name must be above the reference number',
    )
    assert.ok(!page.text.includes(NO_CONTRACT_LABEL_NOTE), 'a captioned row needs no apology')
  })
})

test('a row with no caption says so, and nothing is invented', async () => {
  await withDatabase(async (db) => {
    const { cookie } = await signIn(db, DAVE)
    await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })

    const page = await getPage('/watchlist', cookie)
    assert.match(page.text, /C-2025-2026-Q4-00435/)
    assert.match(page.text, /Department nrc-cnrc/, 'the old shape is kept when there is no name')
    assert.ok(
      page.text.includes(NO_CONTRACT_LABEL_NOTE),
      'a row with no caption must say so rather than leave a blank line',
    )
  })
})

test('pressing Watch again fills in a caption, and a bare link never blanks one', async () => {
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, ALICE)

    // Saved with no caption, as every row before 0003_watch_labels.sql was.
    await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })
    assert.deepEqual(await labelsOf(db, userId), [
      { target_key: CONTRACT, label_name: null, label_dept: null },
    ])

    // Pressing Watch again from the site is the only way such a row ever
    // becomes readable, and the watchlist tells people to do exactly this.
    await postForm(
      '/watch/add',
      { kind: 'contract', key: CONTRACT, name: NAME, dept: DEPT },
      { headers: { cookie } },
    )
    assert.deepEqual(await labelsOf(db, userId), [
      { target_key: CONTRACT, label_name: NAME, label_dept: DEPT },
    ])

    // A bookmark saved before the site sent captions must not undo that.
    await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })
    assert.deepEqual(
      await labelsOf(db, userId),
      [{ target_key: CONTRACT, label_name: NAME, label_dept: DEPT }],
      'a link with no caption must not blank the caption already on the row',
    )
  })
})

// --- the caption through the whole sign-in journey --------------------------

/** The whole most recent dry-run link, including anything after the token. */
function latestLink() {
  assert.ok(SERVER_LOG, 'SERVER_LOG must name the captured server output')
  const matches = [
    ...readFileSync(SERVER_LOG, 'utf8').matchAll(
      /https?:\/\/[^\s"']*\/sign-in\/verify\?token=[^\s"']+/g,
    ),
  ]
  assert.ok(matches.length > 0, 'the server printed no sign-in link')
  return matches[matches.length - 1][0]
}

/** The value of a Set-Cookie the response wrote, or undefined. */
function cookieFrom(response, name) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const eq = pair.indexOf('=')
    if (pair.slice(0, eq).trim() === name) return pair.trim()
  }
  return undefined
}

test('the caption survives being sent to sign in and back', async () => {
  // Pressed while signed out. The caption has to reach the sign-in page, or the
  // person who had to sign in is the one who comes back to the unreadable row
  // this whole change exists to fix.
  const stopped = await fetch(
    `${BASE}/watch?kind=contract&key=${encodeURIComponent(CONTRACT)}` +
      `&name=${encodeURIComponent(NAME)}&dept=${encodeURIComponent(DEPT)}`,
    { redirect: 'manual', headers: { origin: BASE } },
  )
  assert.ok(stopped.status >= 300 && stopped.status < 400)
  const sentTo = new URL(stopped.headers.get('location') ?? '', BASE)
  assert.equal(sentTo.pathname, '/sign-in')
  assert.equal(sentTo.searchParams.get('name'), NAME)
  assert.equal(sentTo.searchParams.get('dept'), DEPT)

  // And into the form on that page, so the next hop carries it.
  const html = await (await fetch(sentTo.toString())).text()
  assert.match(html, /name="name"/)
  assert.match(html, /Skyalyne Canada Inc\./)

  await withDatabase(async () => {
    const asked = await postForm('/auth/request', {
      email: JOURNEY,
      kind: 'contract',
      key: CONTRACT,
      name: NAME,
      dept: DEPT,
    })
    assert.equal(asked.status, 303)

    const cookie = cookieFrom(asked, '__Host-rs_watch')
    assert.ok(cookie, 'the caption travels in the cookie, never in the emailed link')

    // Not in the link. Resend keeps a copy of every message for 30 days and a
    // watchlist item must not be in it; the caption is part of that item.
    const link = latestLink()
    assert.ok(!link.includes('Skyalyne'), 'no caption may reach the emailed link')
    assert.ok(!link.includes('name='), 'the emailed link carries a token and nothing else')

    const token = new URL(link).searchParams.get('token')
    const confirmed = await postForm('/auth/confirm', { token }, { headers: { cookie } })
    assert.equal(confirmed.status, 303)

    const back = new URL(confirmed.headers.get('location') ?? '', BASE)
    assert.equal(back.pathname, '/watch')
    assert.equal(back.searchParams.get('key'), CONTRACT)
    assert.equal(back.searchParams.get('name'), NAME, 'the caption came back with them')
    assert.equal(back.searchParams.get('dept'), DEPT)
  })
})

test('a contract already watched without a name is offered one', async () => {
  // The watchlist tells people to press Watch again to add a missing name.
  // For two hours that instruction was false: pressing Watch again reached a
  // page that said "You are already watching this" and offered only Stop
  // watching, with no way to accept the name. The checks above did not catch
  // it because they post to /watch/add directly, which is not a route a person
  // has. This one goes through the page, as a person does.
  await withDatabase(async (db) => {
    const { cookie, userId } = await signIn(db, BOB)
    await postForm('/watch/add', { kind: 'contract', key: CONTRACT }, { headers: { cookie } })

    const url =
      `/watch?kind=contract&key=${encodeURIComponent(CONTRACT)}` +
      `&name=${encodeURIComponent(NAME)}&dept=${encodeURIComponent(DEPT)}`
    const offered = await getPage(url, cookie)
    assert.match(offered.text, /You are already watching this/)
    assert.match(
      offered.text,
      /Add the supplier name/,
      'a row missing a name must be offered the one that just arrived',
    )

    // And the offer works, not just appears.
    await postForm(
      '/watch/add',
      { kind: 'contract', key: CONTRACT, name: NAME, dept: DEPT },
      { headers: { cookie } },
    )
    assert.deepEqual(await labelsOf(db, userId), [
      { target_key: CONTRACT, label_name: NAME, label_dept: DEPT },
    ])

    // Once it has a name, the offer is gone rather than repeated for ever.
    const after = await getPage(url, cookie)
    assert.ok(
      !after.text.includes('Add the supplier name'),
      'a row that already has the name must not keep asking',
    )
  })
})
