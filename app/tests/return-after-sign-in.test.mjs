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
const ADDRESS = 'returner@example.com'
const ADDRESS_PLAIN = 'plain-returner@example.com'
const ADDRESS_HOSTILE = 'hostile-returner@example.com'

/** see() builds an absolute URL, so compare where it points, not the string. */
function redirectPath(response) {
  const location = response.headers.get('location')
  assert.ok(location, 'no Location header')
  const url = new URL(location, BASE)
  return url.pathname + url.search
}

const TARGET = { kind: 'vendor', key: 'skyalyne' }
const CONTRACT = { kind: 'contract', key: 'pwgsc-tpsgc,C-2024-2025-Q2-00078' }

async function postForm(path, fields) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
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

test('pressing Watch while signed out carries the target to the sign-in page', async () => {
  const res = await fetch(
    `${BASE}/watch?kind=vendor&key=skyalyne`,
    { redirect: 'manual', headers: { origin: BASE } },
  )
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
  // own searchParams into its flight payload, JSON-escaped, on every page —
  // measured, three occurrences, none of them in markup. That is Next echoing
  // the address it was asked for, not this page carrying the value forward.
  //
  // What matters is that it reaches no form field, no link, and no promise.
  assert.ok(
    !/<input[^>]*evil\.example/.test(html),
    'a key that failed validation must not become a form field',
  )
  assert.ok(
    !/href="[^"]*evil\.example/.test(html),
    'a key that failed validation must not become a link',
  )
  assert.ok(
    !html.includes('take you back to what you were about to watch'),
    'the product must not promise to return somebody to a target it refused',
  )
})

test('the whole journey ends on the thing that was pressed', async () => {
  await withDatabase(async () => {
    const asked = await postForm('/auth/request', {
      email: ADDRESS,
      kind: 'vendor',
      key: 'skyalyne',
    })
    assert.equal(asked.status, 303)
    assert.equal(redirectPath(asked), '/sign-in/sent')

    // The emailed link itself must carry it, or opening the link in a different
    // browser from the one that asked would lose the target.
    const link = latestLink()
    const linkQuery = new URL(link).searchParams
    assert.equal(linkQuery.get('kind'), 'vendor', `link was ${link}`)
    assert.equal(linkQuery.get('key'), 'skyalyne')

    // The confirm page hands it to the form it renders.
    const verifyHtml = await (await fetch(link)).text()
    assert.match(verifyHtml, /name="kind"[^>]*value="vendor"|value="vendor"[^>]*name="kind"/)
    assert.match(verifyHtml, /name="key"[^>]*value="skyalyne"|value="skyalyne"[^>]*name="key"/)

    const confirmed = await postForm('/auth/confirm', {
      token: linkQuery.get('token'),
      kind: 'vendor',
      key: 'skyalyne',
    })
    assert.equal(confirmed.status, 303)
    assert.equal(
      redirectPath(confirmed),
      '/watch?kind=vendor&key=skyalyne',
      'signing in must return the person to what they pressed, not to the feed',
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

test('a hostile target at the last hop lands on the feed, not off this site', async () => {
  // The one that matters. If confirm ever echoed what it was given, this is
  // where an attacker would send somebody after they signed in.
  await withDatabase(async () => {
    for (const key of ['//evil.example', 'https://evil.example', '../../evil']) {
      const asked = await postForm('/auth/request', { email: ADDRESS_HOSTILE })
      assert.equal(asked.status, 303)
      const token = new URL(latestLink()).searchParams.get('token')

      const confirmed = await postForm('/auth/confirm', { token, kind: 'vendor', key })
      assert.equal(confirmed.status, 303)
      assert.equal(
        redirectPath(confirmed),
        '/feed',
        `a key of ${key} must not steer the redirect`,
      )
    }
  })
})

test('a failure on the way keeps the target, so the promise is not quietly broken', async () => {
  // The sign-in page has already said "we will take you back to what you were
  // about to watch". Every exit from /auth/request and /auth/confirm returns to
  // that page, and if the target were dropped on the way the promise would be
  // silently withdrawn: the person would sign in successfully and land on an
  // empty feed. At first only the happy path carried it.
  const rejected = await postForm('/auth/request', {
    email: 'not-an-address',
    kind: 'vendor',
    key: 'skyalyne',
  })
  assert.equal(rejected.status, 303)
  const back = new URL(redirectPath(rejected), BASE)
  assert.equal(back.pathname, '/sign-in')
  assert.equal(back.searchParams.get('problem'), 'address')
  assert.equal(back.searchParams.get('kind'), 'vendor')
  assert.equal(back.searchParams.get('key'), 'skyalyne')

  // And an expired link, which is the failure a tester is most likely to meet.
  const expired = await postForm('/auth/confirm', {
    token: 'x'.repeat(43),
    kind: 'vendor',
    key: 'skyalyne',
  })
  assert.equal(expired.status, 303)
  const again = new URL(redirectPath(expired), BASE)
  assert.equal(again.searchParams.get('problem'), 'expired')
  assert.equal(again.searchParams.get('key'), 'skyalyne')
})

test('the check-your-email page says what to look for and where', async () => {
  // This is the one moment a person leaves the product to hunt in a mail
  // client, and a first message from an unfamiliar sender is exactly what a
  // spam filter holds. Naming the subject and the folder costs one sentence.
  const html = await (await fetch(`${BASE}/sign-in/sent`)).text()
  assert.match(html, /Your sign-in link/, 'the subject line must be named')
  assert.match(html, /spam/i, 'the spam folder must be mentioned')
  assert.match(html, /Canadian Recompete Radar/, 'the sender must be named')
})
