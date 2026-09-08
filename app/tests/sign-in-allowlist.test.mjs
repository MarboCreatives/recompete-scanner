// Sign-in closed to an invited list, while the watchlist is being tested.
//
// Until this existed, POST /auth/request sent a link to any address that
// parsed, and that address then had an account and a watchlist. The watchlist
// is to be a paid feature, so the door is shut to the four testers and Jon
// until it is.
//
// ## What each half can and cannot tell apart
//
// The suite is black box over HTTP against a server started as a separate
// process, so **a check here cannot reconfigure that server**. The gate is
// driven by an environment variable, which means the two halves below test
// different things on purpose:
//
//   * The parser checks import `lib/invited.ts` and run in this process, where
//     `process.env` is genuinely ours to set. That is the only place the
//     unset, malformed and mixed-case cases can be decided at all.
//   * The HTTP checks run against the live route with the list the harness gave
//     the server, and prove the gate's POSITION: before the database, before
//     both caps.
//
// **The one case neither half covers is a server booted with no list at all,
// answering over HTTP.** It is the composition of two things proved separately
// here, and it is measured directly by `scanner/harness/check-unset.mjs`, which
// starts a second server without the variable. That is written down rather than
// papered over, because a check that quietly skips the configuration it cannot
// reach is worse than no check: it reads as coverage.
//
// Constants are written out here, not imported from the code under test.
// CODING-STANDARDS 2.4: a check that asks the code what the right answer is
// cannot notice the code being wrong.
//
// Requires BASE_URL and a running server whose INVITED_EMAILS came from
// harness/test-env.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDatabase, visibleText } from './helpers.mjs'
import { installTypeScriptResolver, libUrl } from './ts-resolve.mjs'

installTypeScriptResolver()
// Only the function is imported. The notice is written out below instead of
// imported, deliberately: CODING-STANDARDS 2.4. Asserting the page shows the
// module's own constant would pass on any wording at all, including none.
const { isInvited } = await import(libUrl('invited.ts'))

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

// The caps, written out for the ordering checks. If these stop matching
// src/app/auth/request/route.ts one of the two is a mistake.
const PER_ADDRESS_HOURLY_CAP = 5
const GLOBAL_HOURLY_CAP = 60

// The problem key the gate answers with. Distinct from 'too-many' and 'busy' on
// purpose: the ordering checks below are only provable if the three differ.
const REFUSED = 'not-invited'

// Written out rather than imported, for the same reason as the caps.
const NOTICE =
  'The watchlist is being tested before its full release, so sign in is limited to invited testers right now.'
const REFUSAL_SENTENCE =
  'Sign in is limited to invited testers at the moment. If you were invited, use the address the invitation was sent to.'

// On the harness list; see INVITED_FOR_TESTS in harness/test-env.mjs.
const INVITED = 'invited@example.com'
const STRANGER = 'stranger@example.com'

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

async function tokenCount(db) {
  const r = await db.query('select count(*)::int as n from sign_in_tokens')
  return r.rows[0].n
}

/** Run fn with INVITED_EMAILS set to value, or removed when value is null. */
function withVariable(value, fn) {
  const before = process.env.INVITED_EMAILS
  if (value === null) delete process.env.INVITED_EMAILS
  else process.env.INVITED_EMAILS = value
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.INVITED_EMAILS
    else process.env.INVITED_EMAILS = before
  }
}

/** Every line log() wrote while fn ran, parsed. */
function captureLog(fn) {
  const lines = []
  const real = console.log
  console.log = (line) => lines.push(line)
  try {
    fn()
  } finally {
    console.log = real
  }
  return lines.map((l) => JSON.parse(l))
}

// --- the list itself, decided in this process ------------------------------

test('an unset variable refuses everybody', () => {
  // Fail closed. Failing open would mean a redeploy that lost the variable
  // silently reopening sign-in to the world, which is the failure nobody
  // notices until it matters.
  withVariable(null, () => {
    assert.equal(isInvited('invited@example.com'), false)
    assert.equal(isInvited('jon@example.com'), false)
    assert.equal(isInvited(''), false)
  })
})

test('an unset variable says so in the log, once, with no address in it', () => {
  const lines = withVariable(null, () => captureLog(() => isInvited('someone@example.com')))
  assert.deepEqual(lines, [{ event: 'sign_in_allowlist_missing' }])
  // The whole line, not a field of it: nothing here may carry an address.
  assert.ok(!JSON.stringify(lines).includes('@'), 'no at sign may reach a log line')
})

test('an invited address is admitted and anybody else is refused', () => {
  withVariable('one@example.com,two@example.com', () => {
    assert.equal(isInvited('one@example.com'), true)
    assert.equal(isInvited('two@example.com'), true)
    assert.equal(isInvited('three@example.com'), false)
    // Not a prefix, not a suffix, not a substring. The comparison is exact.
    assert.equal(isInvited('one@example.co'), false)
    assert.equal(isInvited('aone@example.com'), false)
    assert.equal(isInvited('one@example.como'), false)
  })
})

test('mixed case, padding and a trailing comma all work, and raise no alarm', () => {
  // The shape a person actually types into a dashboard field.
  //
  // The trailing space after the last comma is load-bearing and was measured
  // into this string. Ending at the comma makes the final segment exactly ''
  // which is skipped with or without the trim, so the break harness could not
  // tell the two apart. A comma followed by a space is what a person actually
  // leaves behind, and it is the case the trim exists for.
  const untidy = '  ONE@Example.COM , two@example.com , '
  const lines = withVariable(untidy, () =>
    captureLog(() => {
      assert.equal(isInvited('one@example.com'), true)
      assert.equal(isInvited('two@example.com'), true)
    }),
  )

  // And it must do so SILENTLY. This half is the point of the case, and it was
  // added because break-invited.py proved the first version could not fail:
  // normalizeEmail trims its own input, so removing the trim in invited.ts
  // changed no answer above and the check passed on broken code. What the trim
  // actually protects is this — a space after a comma is not an entry, and
  // must not be counted as a broken one. That alarm exists to tell Jon he has
  // a typo, and an alarm that cries wolf on a correct list is worse than none.
  assert.deepEqual(lines, [], 'a well-formed but untidy list must log nothing at all')

  // Empty segments are dropped rather than becoming an entry that matches ''.
  withVariable(',,,', () => {
    assert.equal(isInvited(''), false)
  })
})

test('a byte-order mark on the first entry does not lock that tester out', () => {
  // GROUND-TRUTH G21: piping a value into `vercel env add` from PowerShell
  // stores it with a UTF-8 byte-order mark, which is what made APP_URL answer
  // 403 to every form. U+FEFF is JavaScript whitespace, so trim() removes it
  // and this variable survives the same mistake. Measured, not assumed, and
  // this check is what keeps it true.
  withVariable('\uFEFFone@example.com,two@example.com', () => {
    assert.equal(isInvited('one@example.com'), true)
  })
})

test('an entry that will not parse is counted out loud, never printed', () => {
  const lines = withVariable('good@example.com,not-an-address,a@b', () =>
    captureLog(() => {
      assert.equal(isInvited('good@example.com'), true, 'a good entry still works')
      assert.equal(isInvited('not-an-address'), false, 'a bad entry admits nobody')
    }),
  )
  // Two calls, so the count is reported twice; both say two entries were bad.
  assert.deepEqual(lines, [
    { event: 'sign_in_allowlist_entry_invalid', count: 2 },
    { event: 'sign_in_allowlist_entry_invalid', count: 2 },
  ])
  assert.ok(!JSON.stringify(lines).includes('@'), 'no at sign may reach a log line')
})

test('a list with nothing usable in it is silent about the variable existing', () => {
  // Set but useless is not the same as unset, and must not claim to be: a
  // person reading the log has to be able to tell "I never set it" from
  // "I set it wrong".
  const lines = withVariable('not-an-address', () => captureLog(() => isInvited('x@example.com')))
  assert.deepEqual(lines, [{ event: 'sign_in_allowlist_entry_invalid', count: 1 }])
  assert.ok(
    !lines.some((l) => l.event === 'sign_in_allowlist_missing'),
    'a variable that is set must not be reported as missing',
  )
})

// --- the gate on the live route --------------------------------------------

test('an invited address still gets a link, exactly as before', async () => {
  await withDatabase(async (db) => {
    const r = await askForLink(INVITED)
    assert.equal(r.status, 303)
    assert.equal(
      new URL(r.headers.get('location'), BASE).pathname,
      '/sign-in/sent',
      'the gate must not change anything for somebody who was invited',
    )
    assert.equal(await tokenCount(db), 1, 'an invited request writes its token row')
  })
})

test('an uninvited address is refused, and nothing is written or sent', async () => {
  await withDatabase(async (db) => {
    const r = await askForLink(STRANGER)
    assert.equal(r.status, 303)
    assert.equal(problem(r), REFUSED)

    // The gate runs before any database work, so a refused request leaves no
    // trace: no token row, and therefore no email either, since the send is
    // downstream of the insert.
    assert.equal(await tokenCount(db), 0, 'a refused request must write no token row')
  })
})

test('the gate answers before the per-address cap is counted', async () => {
  await withDatabase(async (db) => {
    await seedTokens(db, PER_ADDRESS_HOURLY_CAP, STRANGER)
    const r = await askForLink(STRANGER)
    assert.equal(problem(r), REFUSED)
    assert.notEqual(
      problem(r),
      'too-many',
      'the allowlist gate must answer before the per-address cap is counted',
    )
  })
})

test('an uninvited attempt cannot spend the cap that protects the testers', async () => {
  // The one that matters. The global cap is charged by failed sends by design,
  // so if the gate ran after it, a stranger holding down the button could close
  // sign-in for the four testers and for Jon for the rest of the hour.
  await withDatabase(async (db) => {
    for (let i = 0; i < 5; i++) {
      const r = await askForLink(`stranger-${i}@example.com`)
      assert.equal(problem(r), REFUSED)
    }
    assert.equal(await tokenCount(db), 0, 'uninvited attempts must charge nothing')

    // And with the global cap already at its limit, an uninvited address still
    // gets the allowlist answer rather than the busy one.
    await seedTokens(db, GLOBAL_HOURLY_CAP)
    const refused = await askForLink(STRANGER)
    assert.equal(problem(refused), REFUSED)
    assert.notEqual(
      problem(refused),
      'busy',
      'the allowlist gate must answer before the global cap is counted',
    )
  })

  // Fresh window: an invited address is unaffected by everything above.
  await withDatabase(async () => {
    const r = await askForLink(INVITED)
    assert.equal(
      new URL(r.headers.get('location'), BASE).pathname,
      '/sign-in/sent',
      'an invited tester must still get in after a stranger has hammered the form',
    )
  })
})

test('a malformed address is still answered as malformed, not as uninvited', async () => {
  // The address check runs first and stays first. Telling somebody their typo
  // is an invitation problem would send them looking for the wrong thing.
  await withDatabase(async () => {
    const r = await askForLink('not-an-address')
    assert.equal(problem(r), 'address')
  })
})

// --- what a visitor is told before they type -------------------------------

test('the sign-in page carries the testing notice, above the address field', async () => {
  const html = await (await fetch(`${BASE}/sign-in`)).text()
  const text = visibleText(html)

  assert.ok(text.includes(NOTICE), 'the standing notice must be on the page')
  assert.ok(
    text.indexOf(NOTICE) < text.indexOf('Email address'),
    'it must be readable before anyone types an address, not after',
  )
})

test('the notice is shown to somebody who pressed Watch and was stopped here', async () => {
  // This is where a visitor who clicked Watch on recompeteradar.ca lands, and
  // the reason the notice is on this page rather than on the site.
  const html = await (
    await fetch(`${BASE}/sign-in?kind=vendor&key=skyalyne`)
  ).text()
  assert.ok(visibleText(html).includes(NOTICE))
})

test('the notice and the refusal are different sentences, neither inside the other', () => {
  // The page's own rule: no sentence it shows is a substring of another, so a
  // check asserting one is present cannot be satisfied by a different one.
  assert.ok(!REFUSAL_SENTENCE.includes(NOTICE))
  assert.ok(!NOTICE.includes(REFUSAL_SENTENCE))
})

test('the refused page says it once, not twice', async () => {
  // Both sentences mean "sign in is closed to invited testers". One above the
  // other, they read as the page repeating itself, which is what the refusal
  // page did until 8 September. The refusal is the more specific of the two and
  // it is the one that stays.
  const text = visibleText(
    await (await fetch(`${BASE}/sign-in?problem=${REFUSED}`)).text(),
  )
  assert.ok(text.includes(REFUSAL_SENTENCE), 'the refusal sentence must be shown')
  assert.ok(
    !text.includes(NOTICE),
    'the standing notice must stand down, or the page says the same thing twice',
  )
})

test('the notice stands down for that refusal and for nothing else', async () => {
  // Without this, hiding the notice on EVERY problem page would satisfy the
  // check above while quietly taking it off pages that still need it. Each
  // problem below is about something going wrong; none of them explains why
  // sign in is closed at all, so the notice is still the only thing that does.
  const others = ['expired', 'too-many', 'address', 'email']
  assert.ok(others.length > 0, 'an empty list here would prove nothing')

  let checked = 0
  for (const other of others) {
    const text = visibleText(
      await (await fetch(`${BASE}/sign-in?problem=${other}`)).text(),
    )
    assert.ok(
      text.includes(NOTICE),
      `the standing notice must survive problem=${other}`,
    )
    checked += 1
  }
  assert.equal(checked, others.length, 'every problem in the list must be tried')
})
