// What a refused form submission tells the person who sent it.
//
// This exists because of a real hour lost on 6 September 2026. The deployment
// answers on four addresses and only the one APP_URL names is accepted; the
// other three sit behind the hosting provider's own login, so somebody signed
// in there sees the sign-in page render perfectly, presses the button, and
// receives one word: "Forbidden." It is indistinguishable from the site being
// broken, and it is the same bare 403 that an unset APP_URL produced twice
// before.
//
// The refusal itself is not relaxed by any of this. These checks assert both
// halves: that the request is still refused, and that the refusal says where
// to go instead.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { visibleText } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

/** Every route that refuses a request whose origin does not match. */
const MUTATIONS = [
  ['/auth/request', { email: 'someone@example.com' }],
  ['/auth/confirm', { token: 'x' }],
  ['/auth/sign-out', {}],
  ['/account/delete', { confirm: 'yes' }],
  ['/watch/add', { kind: 'contract', key: 'ic,C-2025-2026-Q1-00127' }],
  ['/watch/remove', { kind: 'contract', key: 'ic,C-2025-2026-Q1-00127' }],
]

async function refused(path, fields, origin) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' }
  if (origin !== undefined) headers.origin = origin
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body: new URLSearchParams(fields),
  })
}

test('every mutation still refuses a request from the wrong address', async () => {
  for (const [path, fields] of MUTATIONS) {
    for (const origin of [undefined, 'https://evil.example', 'https://recompete-scanner-git-main.vercel.app']) {
      const r = await refused(path, fields, origin)
      assert.equal(r.status, 403, `${path} with origin ${String(origin)} must be refused`)
    }
  }
})

test('the refusal names the address that does work, so it is not a dead end', async () => {
  const r = await refused('/auth/request', { email: 'someone@example.com' }, 'https://evil.example')
  const text = visibleText(await r.text())

  assert.match(text, /Not accepted from this address/)
  assert.match(text, /You opened it at a different address, so nothing was submitted\./)
  assert.match(text, /Nothing was changed and nothing was sent\./)

  // The address itself, taken from the environment rather than from the page,
  // so this cannot pass by the page quoting itself.
  const expected = process.env.APP_URL ?? BASE
  assert.ok(
    text.includes(expected),
    `the refusal must name ${expected}; it said: ${text.slice(0, 200)}`,
  )

  // And it must be a link, not just words, because the whole point is that the
  // person can get to the right place from here.
  const raw = await (await refused('/auth/request', {}, 'https://evil.example')).text()
  assert.match(raw, new RegExp(`<a href="${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
})

test('the refusal is a page a phone can read, not a wall of text', async () => {
  const r = await refused('/watch/add', { kind: 'contract', key: 'ic,C-1' }, 'https://evil.example')
  assert.match(r.headers.get('content-type') ?? '', /text\/html/)
  const raw = await r.text()
  assert.match(raw, /<meta name="viewport"/)
})

test('forbidden() is given nothing from the request, so it can echo nothing', () => {
  // This is the real guarantee, and it is structural rather than behavioural.
  // A page that echoed the rejected origin would put attacker-chosen text on a
  // page this site served; the reason it cannot is that the helper takes no
  // arguments at all, so the request is not in scope where the body is built.
  //
  // Asserted on the source rather than over HTTP on purpose. The HTTP version
  // of this check passed no matter what, because with no parameter there is
  // nothing to echo, so it could never have failed and proved nothing. That
  // was found by breaking it.
  const source = readFileSync(join(here, '..', 'src', 'lib', 'http.ts'), 'utf8')
  assert.match(
    source,
    /export function forbidden\(\): Response \{/,
    'forbidden() must take no arguments; giving it the request is how an echo starts',
  )
})

test('the refusal repeats nothing back that the request supplied', async () => {
  // Belt and braces over the check above. It would still catch a body that
  // reached for request data another way, such as through the framework's own
  // header accessor rather than through a parameter.
  const r = await refused(
    '/auth/request',
    { email: 'someone@example.com' },
    'https://<script>alert(1)</script>.example',
  )
  const raw = await r.text()
  assert.ok(!raw.includes('<script>alert(1)</script>'), 'the rejected origin must not be echoed')
  assert.ok(!raw.includes('someone@example.com'), 'the submitted address must not be echoed')
})
