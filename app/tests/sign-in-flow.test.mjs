// Drives sign in, sign out and their failure paths over real HTTP, against a
// running server.
//
// This is the check that matters most, because it follows the link the
// application itself produced rather than one the test built. A one-word bug
// such as putting the digest in the link instead of the raw token, or renaming
// the form field, would pass every unit test and fail here.
//
// Requires BASE_URL, and a server started with EMAIL_DRY_RUN=1 whose output is
// captured at SERVER_LOG. The dry run prints the link instead of sending it,
// which is how the whole flow is testable before any email account exists.
//
// Every case runs inside withDatabase, which closes the connection even when an
// assertion fails. Without that, a failing test left the socket open and the
// run hung rather than reporting the failure; in CI that reads as a timeout
// instead of as the thing that actually broke.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withDatabase, visibleText } from './helpers.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const SERVER_LOG = process.env.SERVER_LOG
const ADDRESS = 'someone@example.com'

/** POST a form without following the redirect, so the status can be asserted. */
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

/** The most recent dry-run link the server printed. */
function latestLinkFromLog() {
  assert.ok(SERVER_LOG, 'SERVER_LOG must name the captured server output')
  const text = readFileSync(SERVER_LOG, 'utf8')
  const matches = [
    ...text.matchAll(/https?:\/\/[^\s"']*\/sign-in\/verify\?token=[A-Za-z0-9_-]{43}/g),
  ]
  assert.ok(matches.length > 0, 'the server printed no sign-in link')
  return matches[matches.length - 1][0]
}

test('the whole sign-in journey, following the link the application produced', async () => {
  await withDatabase(async (db) => {
    // 1. Ask for a link.
    const asked = await postForm('/auth/request', { email: ADDRESS })
    assert.equal(asked.status, 303, 'asking for a link redirects')
    assert.match(asked.headers.get('location'), /\/sign-in\/sent$/)

    const tokens = await db.query('select email from sign_in_tokens')
    assert.equal(tokens.rows.length, 1, 'exactly one token row')
    assert.equal(tokens.rows[0].email, ADDRESS)

    // 2. Open the link the server itself emitted.
    const link = latestLinkFromLog()
    const page = await fetch(link, { redirect: 'manual' })
    assert.equal(page.status, 200)
    const html = visibleText(await page.text())
    assert.match(html, /You are about to sign in as someone@example\.com\./)
    assert.match(html, /Only continue if you asked for this link\./)

    // Opening the link must not sign anyone in: mail scanners follow URLs found
    // in email, and would otherwise spend the token before the person saw it.
    const stillThere = await db.query('select count(*)::int as n from sign_in_tokens')
    assert.equal(stillThere.rows[0].n, 1, 'opening the link must not spend the token')
    const noSessions = await db.query('select count(*)::int as n from sessions')
    assert.equal(noSessions.rows[0].n, 0, 'opening the link must not create a session')

    // 3. Confirm.
    const token = new URL(link).searchParams.get('token')
    const confirmed = await postForm('/auth/confirm', { token })
    assert.equal(confirmed.status, 303)
    assert.match(confirmed.headers.get('location'), /\/feed$/)

    const setCookie = confirmed.headers.get('set-cookie')
    assert.ok(setCookie, 'a session cookie must be set')
    assert.match(setCookie, /__Host-rs_session=/)
    assert.match(setCookie, /Secure/, '__Host- cookies are refused without Secure')
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /Path=\//)
    assert.doesNotMatch(setCookie, /Domain=/, '__Host- cookies must carry no Domain')

    const spent = await db.query('select count(*)::int as n from sign_in_tokens')
    assert.equal(spent.rows[0].n, 0, 'confirming must consume the token')
    const users = await db.query('select email from users')
    assert.equal(users.rows.length, 1)
    assert.equal(users.rows[0].email, ADDRESS)
    const prefs = await db.query('select count(*)::int as n from alert_preferences')
    assert.equal(prefs.rows[0].n, 1, 'preferences are created at first sign in')

    // 4. The feed, using that cookie.
    const cookie = setCookie.split(';')[0]
    const feed = await fetch(`${BASE}/feed`, { headers: { cookie }, redirect: 'manual' })
    assert.equal(feed.status, 200)
    const feedHtml = visibleText(await feed.text())
    assert.match(feedHtml, /someone@example\.com/)
    assert.match(feedHtml, /Following contracts and vendors arrives in the next release\./)
    assert.match(feedHtml, /option years that are not published until they are exercised/)

    // 5. The same link cannot be used twice.
    const replay = await postForm('/auth/confirm', { token })
    assert.equal(replay.status, 303)
    assert.match(replay.headers.get('location'), /problem=expired/)

    // 6. Sign out.
    const out = await postForm('/auth/sign-out', {}, { headers: { cookie } })
    assert.equal(out.status, 303)
    assert.match(out.headers.get('location'), /\/$/)
    const clearing = out.headers.get('set-cookie')
    assert.ok(clearing, 'sign out must send a clearing cookie')
    assert.match(clearing, /Secure/, 'a clearing cookie without Secure is ignored for __Host-')
    assert.match(clearing, /Path=\//)

    const gone = await db.query('select count(*)::int as n from sessions')
    assert.equal(gone.rows[0].n, 0, 'the session row must be deleted, not only the cookie')

    // 7. The old cookie no longer works.
    const after = await fetch(`${BASE}/feed`, { headers: { cookie }, redirect: 'manual' })
    assert.ok([302, 303, 307].includes(after.status), `expected a redirect, got ${after.status}`)
    assert.match(after.headers.get('location'), /\/sign-in/)
  })
})

test('a malformed address is refused without creating anything', async () => {
  await withDatabase(async (db) => {
    for (const bad of ['abc@d.e', 'not-an-address', '', 'jon @example.com']) {
      const r = await postForm('/auth/request', { email: bad })
      assert.equal(r.status, 303, `${bad} should redirect`)
      assert.match(r.headers.get('location'), /problem=address/, `${bad} should be refused`)
    }
    const n = await db.query('select count(*)::int as n from sign_in_tokens')
    assert.equal(n.rows[0].n, 0, 'a refused address must not create a token')
  })
})

test('a POST without a matching Origin is forbidden and touches nothing', async () => {
  await withDatabase(async (db) => {
    for (const path of ['/auth/request', '/auth/confirm', '/auth/sign-out']) {
      const r = await fetch(`${BASE}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: ADDRESS, token: 'x' }),
      })
      assert.equal(r.status, 403, `${path} must refuse a request with no Origin`)
      assert.equal((await r.text()).trim(), 'Forbidden.')
    }

    for (const origin of ['https://evil.example', 'not a url', '']) {
      const r = await postForm('/auth/request', { email: ADDRESS }, { headers: { origin } })
      assert.equal(r.status, 403, `origin ${JSON.stringify(origin)} must be refused`)
    }

    const n = await db.query('select count(*)::int as n from sign_in_tokens')
    assert.equal(n.rows[0].n, 0, 'a forbidden request must not reach the database')
  })
})

test('the per-address cap stops at five and says so honestly', async () => {
  await withDatabase(async (db) => {
    for (let i = 0; i < 5; i += 1) {
      const r = await postForm('/auth/request', { email: ADDRESS })
      assert.match(r.headers.get('location'), /\/sign-in\/sent$/, `request ${i + 1} should succeed`)
    }
    const sixth = await postForm('/auth/request', { email: ADDRESS })
    assert.match(sixth.headers.get('location'), /problem=too-many/)

    const n = await db.query('select count(*)::int as n from sign_in_tokens')
    assert.equal(n.rows[0].n, 5, 'the refused request must not add a sixth token')
  })
})

test('every sign-in problem shows its own sentence and none of the others', async () => {
  // The eight sentences are pairwise distinct and none is a substring of
  // another, so asserting the others are absent is meaningful.
  const expected = {
    address: 'That address does not look like an email address.',
    email: 'We could not send a sign-in link to that address just now.',
    expired: 'This link has expired or was already used.',
    unavailable: 'We could not finish signing you in just now.',
    unreachable: 'We could not reach the database just now.',
    'too-many': 'Too many sign-in links have been asked for from this address in the last hour.',
    busy: 'Too many sign-in links have been asked for just now.',
    signout: 'You are signed out on this device.',
  }

  for (const [problem, sentence] of Object.entries(expected)) {
    const r = await fetch(`${BASE}/sign-in?problem=${problem}`)
    assert.equal(r.status, 200)
    const text = visibleText(await r.text())
    assert.ok(text.includes(sentence), `?problem=${problem} should say: ${sentence}`)
    for (const [other, otherSentence] of Object.entries(expected)) {
      if (other === problem) continue
      assert.ok(
        !text.includes(otherSentence),
        `?problem=${problem} must not also show the ${other} sentence`,
      )
    }
  }

  // With no problem parameter, none of them appears.
  const plain = visibleText(await (await fetch(`${BASE}/sign-in`)).text())
  for (const sentence of Object.values(expected)) {
    assert.ok(!plain.includes(sentence), `the plain sign-in page must not show: ${sentence}`)
  }
})

test('an invalid or unknown link is refused with the right wording', async () => {
  const notShaped = visibleText(await (await fetch(`${BASE}/sign-in/verify?token=nope`)).text())
  assert.ok(notShaped.includes('This link is not valid.'))

  const unknown = visibleText(
    await (await fetch(`${BASE}/sign-in/verify?token=${'A'.repeat(43)}`)).text(),
  )
  assert.ok(unknown.includes('This link has expired or was already used.'))
})

test('the server output never contains the address it was given', () => {
  assert.ok(SERVER_LOG, 'SERVER_LOG must be set')
  const text = readFileSync(SERVER_LOG, 'utf8')
  assert.ok(
    !text.includes(ADDRESS),
    'the address reached the server log; the redaction is not holding',
  )
})
