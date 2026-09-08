// Pressing Watch while signed out, and being put back where you were.
//
// Before this existed, a person on recompeteradar.ca pressed "Watch this
// supplier", was sent to sign in, confirmed the emailed link, and landed on an
// empty feed with no memory of what they had pressed. They would have had to
// return to the site and find it again, and most would have concluded it had
// not worked. This is the journey that makes the Watch links on the public site
// worth having, so it is checked end to end over real HTTP rather than by
// reading the four hops and believing them.
//
// The target travels as `kind` and `key`, and is re-parsed at every hop by
// parseWatchTarget and written out again by withWatchTarget or watchPath.
// Nothing echoes a destination, which is what stops this being an open
// redirect. The last two cases are the ones that prove that, and they are the
// reason this file exists as much as the happy path is.
//
// Requires BASE_URL and a server started with EMAIL_DRY_RUN=1 whose output is
// captured at SERVER_LOG.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withDatabase } from './helpers.mjs'
import { installTypeScriptResolver, libUrl } from './ts-resolve.mjs'

installTypeScriptResolver()
const { withWatchTarget, parseWatchTarget } = await import(libUrl('watch.ts'))

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const SERVER_LOG = process.env.SERVER_LOG
// A separate address per case: the per-address cap is five links an hour,
// and a shared address would make a later case fail for the wrong reason.
const ADDRESS_PLAIN = 'plain-returner@example.com'
const ADDRESS_HOSTILE = 'hostile-returner@example.com'
const ADDRESS_JOURNEY = 'journey-returner@example.com'
const ADDRESS_LINK = 'link-returner@example.com'

/** see() builds an absolute URL, so compare where it points, not the string. */
function redirectPath(response) {
  const location = response.headers.get('location')
  assert.ok(location, 'no Location header')
  const url = new URL(location, BASE)
  return url.pathname + url.search
}

const TARGET = { kind: 'vendor', key: 'skyalyne' }
const CONTRACT = { kind: 'contract', key: 'pwgsc-tpsgc,C-2024-2025-Q2-00078' }

async function postForm(path, fields, extra = {}) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE,
      ...(extra.cookie ? { cookie: extra.cookie } : {}),
    },
    body: new URLSearchParams(fields),
  })
}

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

// --- the helper, on its own -------------------------------------------------

test('a target is written into a path, and a missing one changes nothing', () => {
  assert.equal(withWatchTarget('/sign-in', null), '/sign-in')
  assert.equal(withWatchTarget('/sign-in', TARGET), '/sign-in?kind=vendor&key=skyalyne')
  // Onto a path that already carries a query, which is the emailed link.
  assert.equal(
    withWatchTarget('https://e.example/sign-in/verify?token=abc', TARGET),
    'https://e.example/sign-in/verify?token=abc&kind=vendor&key=skyalyne',
  )
  // A contract key contains a comma, which must survive as one value.
  assert.equal(
    withWatchTarget('/sign-in', CONTRACT),
    '/sign-in?kind=contract&key=pwgsc-tpsgc%2CC-2024-2025-Q2-00078',
  )
})

test('a hostile destination cannot be smuggled through the target', () => {
  // These are the shapes an open redirect would need. None of them is a legal
  // key, so parseWatchTarget returns null and nothing is ever appended.
  for (const key of [
    '//evil.example',
    'https://evil.example',
    '../../evil',
    '/feed?x=1',
    'skyalyne&next=https://evil.example',
  ]) {
    assert.equal(parseWatchTarget('vendor', key), null, `${key} must not parse`)
  }
})

// --- the four hops, over HTTP ----------------------------------------------

/** The value of a Set-Cookie the response wrote, or undefined. */
function cookieFrom(response, name) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const eq = pair.indexOf('=')
    if (pair.slice(0, eq).trim() === name) return pair.trim()
  }
  return undefined
}

test('pressing Watch while signed out carries the target to the sign-in page', async () => {
  const res = await fetch(`${BASE}/watch?kind=vendor&key=skyalyne`, {
    redirect: 'manual',
    headers: { origin: BASE },
  })
  assert.ok(res.status >= 300 && res.status < 400, `expected a redirect, got ${res.status}`)
  const location = res.headers.get('location') ?? ''
  assert.match(location, /\/sign-in\?/, 'must be sent to sign in')
  const query = new URL(location, BASE).searchParams
  assert.equal(query.get('kind'), 'vendor')
  assert.equal(query.get('key'), 'skyalyne')
})

test('the sign-in page carries the target into its form, and says so', async () => {
  const html = await (await fetch(`${BASE}/sign-in?kind=vendor&key=skyalyne`)).text()
  assert.match(html, /name="kind"[^>]*value="vendor"|value="vendor"[^>]*name="kind"/)
  assert.match(html, /name="key"[^>]*value="skyalyne"|value="skyalyne"[^>]*name="key"/)
  assert.match(html, /take you back to what you were about to watch/)
})

test('an unparseable target is dropped at the sign-in page rather than carried', async () => {
  const html = await (await fetch(`${BASE}/sign-in?kind=vendor&key=%2F%2Fevil.example`)).text()

  // Not a blanket search for the string. The framework serialises the route's
  // own searchParams into its flight payload, JSON-escaped, on every page -
  // measured, three occurrences, none of them in markup. That is Next echoing
  // the address it was asked for, not this page carrying the value forward.
  assert.ok(!/<input[^>]*evil\.example/.test(html), 'must not become a form field')
  assert.ok(!/href="[^"]*evil\.example/.test(html), 'must not become a link')
  assert.ok(
    !html.includes('take you back to what you were about to watch'),
    'the product must not promise to return somebody to a target it refused',
  )
})

test('the emailed link carries a token and nothing about a watchlist', async () => {
  // The privacy decision this flow is built around. Resend keeps a copy of every
  // message for 30 days, and the account page promises exactly that. A watch
  // target in the link would put a watchlist item into that retained copy, and a
  // watchlist is personal data under MASTER-DESIGN rule 8. The first
  // implementation of this feature put it in the link; this is the check that
  // stops it coming back.
  await withDatabase(async () => {
    const asked = await postForm('/auth/request', {
      email: ADDRESS_LINK,
      kind: 'vendor',
      key: 'skyalyne',
    })
    assert.equal(asked.status, 303)

    const link = latestLink()
    const params = new URL(link).searchParams
    assert.ok(params.get('token'), 'the link must carry a token')
    assert.equal(params.get('kind'), null, 'the link must not name what was watched')
    assert.equal(params.get('key'), null, 'the link must not name what was watched')
    assert.ok(!link.includes('skyalyne'), `the key must not appear anywhere in ${link}`)

    // It is on the device that asked instead. Decoded rather than searched for
    // as a substring: the cookie is base64url of [kind, key, name, dept], so a
    // substring check would fail on a correct cookie and could pass on one that
    // merely happened to contain the letters. Decoding asserts the actual
    // fields, which is what this check was always trying to say.
    const jar = cookieFrom(asked, '__Host-rs_watch')
    assert.ok(jar, 'the intent must be stored on the device that asked')
    const stored = JSON.parse(
      Buffer.from(jar.slice(jar.indexOf('=') + 1), 'base64url').toString('utf8'),
    )
    assert.deepEqual(stored.slice(0, 2), ['vendor', 'skyalyne'])
  })
})

test('the whole journey ends on the thing that was pressed', async () => {
  await withDatabase(async () => {
    const asked = await postForm('/auth/request', {
      email: ADDRESS_JOURNEY,
      kind: 'contract',
      key: 'pwgsc-tpsgc,C-2024-2025-Q2-00078',
    })
    assert.equal(asked.status, 303)
    assert.equal(redirectPath(asked), '/sign-in/sent')

    const cookie = cookieFrom(asked, '__Host-rs_watch')
    assert.ok(cookie, 'no intent cookie was set')

    const token = new URL(latestLink()).searchParams.get('token')
    const confirmed = await postForm('/auth/confirm', { token }, { cookie })
    assert.equal(confirmed.status, 303)
    assert.equal(
      redirectPath(confirmed),
      '/watch?kind=contract&key=pwgsc-tpsgc%2CC-2024-2025-Q2-00078',
      'signing in must return the person to what they pressed, not to the feed',
    )

    // And the intent is spent, so a later sign in cannot inherit it.
    assert.equal(
      cookieFrom(confirmed, '__Host-rs_watch'),
      '__Host-rs_watch=',
      'the intent must be cleared once used',
    )
  })
})

test('signing in without pressing Watch still lands on the feed', async () => {
  await withDatabase(async () => {
    const asked = await postForm('/auth/request', { email: ADDRESS_PLAIN })
    assert.equal(asked.status, 303)
    const token = new URL(latestLink()).searchParams.get('token')
    const confirmed = await postForm('/auth/confirm', { token })
    assert.equal(confirmed.status, 303)
    assert.equal(redirectPath(confirmed), '/feed')
  })
})

test('a hostile intent cookie cannot steer the redirect off this site', async () => {
  // The cookie is httpOnly, so this is not a shape a page can produce. It is
  // what somebody with the browser in their hands could set, and the answer has
  // to be the same: the value is re-parsed on the way out and can only ever
  // name /watch on this origin.
  await withDatabase(async () => {
    for (const value of [
      '__Host-rs_watch=vendor:%2F%2Fevil.example',
      '__Host-rs_watch=vendor:https%3A%2F%2Fevil.example',
      '__Host-rs_watch=https://evil.example',
      '__Host-rs_watch=vendor:%E0%A4%A',
    ]) {
      const asked = await postForm('/auth/request', { email: ADDRESS_HOSTILE })
      assert.equal(asked.status, 303)
      const token = new URL(latestLink()).searchParams.get('token')
      const confirmed = await postForm('/auth/confirm', { token }, { cookie: value })
      assert.equal(confirmed.status, 303)
      assert.equal(redirectPath(confirmed), '/feed', `${value} must not steer the redirect`)
    }
  })
})

test('a failure on the way keeps the target, so the promise is not quietly broken', async () => {
  // The sign-in page has already said "we will take you back to what you were
  // about to watch". Every exit from /auth/request and /auth/confirm returns to
  // that page, and if the target were dropped the promise would be silently
  // withdrawn. At first only the happy path carried it.
  const rejected = await postForm('/auth/request', {
    email: 'not-an-address',
    kind: 'vendor',
    key: 'skyalyne',
  })
  assert.equal(rejected.status, 303)
  const back = new URL(redirectPath(rejected), BASE)
  assert.equal(back.pathname, '/sign-in')
  assert.equal(back.searchParams.get('problem'), 'address')
  assert.equal(back.searchParams.get('key'), 'skyalyne')

  // An expired link is the failure a tester is most likely to meet. Here the
  // intent comes from the cookie, and must survive rather than be consumed.
  const expired = await postForm(
    '/auth/confirm',
    { token: 'x'.repeat(43) },
    { cookie: '__Host-rs_watch=vendor:skyalyne' },
  )
  assert.equal(expired.status, 303)
  const again = new URL(redirectPath(expired), BASE)
  assert.equal(again.searchParams.get('problem'), 'expired')
  assert.equal(again.searchParams.get('key'), 'skyalyne')

  // And the intent must SURVIVE the failure. Asserting the redirect alone does
  // not test this: reading the cookie and consuming it produce an identical
  // Location, so a failure path that spent the intent looked correct. The break
  // harness caught that. What differs is whether the response clears the cookie.
  assert.notEqual(
    cookieFrom(expired, '__Host-rs_watch'),
    '__Host-rs_watch=',
    'a failed confirmation must not spend the intent; the retry still needs it',
  )
})

test('the check-your-email page says what to look for and where', async () => {
  const html = await (await fetch(`${BASE}/sign-in/sent`)).text()
  assert.match(html, /Your sign-in link/, 'the subject line must be named')
  assert.match(html, /spam/i, 'the spam folder must be mentioned')
  assert.match(html, /Canadian Recompete Radar/, 'the sender must be named')
})
