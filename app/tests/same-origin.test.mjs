// The origin decision itself, exercised directly.
//
// This is the check that was missing behind three separate outages. G17 was an
// unset APP_URL, G21 was an APP_URL with an invisible byte in front of it, G28
// was a response header that made browsers stop sending the Origin at all, and
// a fourth was `localhost` and `127.0.0.1` being different origins on one
// machine. Every one of them turned every form on the site into a bare 403.
//
// None of them could be caught by the HTTP checks, and the reason is
// structural: those checks hand the server the Origin header themselves, from
// the same constant they used to build the request, so the value sent and the
// value expected are two copies of one string and can never disagree. And
// tests/static.test.mjs only greps route files for the text `isSameOrigin(`;
// it never asks what the function decides.
//
// So this file calls the function. It builds a Request the way a browser would
// and asserts the answer, with the environment set to each deployment shape in
// turn. No database, no server.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTypeScriptResolver, libUrl } from './ts-resolve.mjs'

installTypeScriptResolver()
const { isSameOrigin } = await import(libUrl('same-origin.ts'))
const { appUrl } = await import(libUrl('env.ts'))

/** The variables appUrl() and the local-development guard read. */
const KEYS = ['APP_URL', 'VERCEL', 'VERCEL_ENV', 'VERCEL_BRANCH_URL', 'PORT']

function withEnvironment(values, body) {
  const saved = {}
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  try {
    for (const [k, v] of Object.entries(values)) process.env[k] = v
    return body()
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

/** A request carrying whatever a browser would have put in the Origin header. */
function from(origin) {
  const headers = origin === null ? {} : { origin }
  return new Request('https://example.test/auth/request', { method: 'POST', headers })
}

const DEPLOYED = { VERCEL: '1', VERCEL_ENV: 'production', APP_URL: 'https://recompete-scanner.vercel.app' }

test('a deployment accepts exactly the address it is configured with', () => {
  withEnvironment(DEPLOYED, () => {
    assert.equal(appUrl(), 'https://recompete-scanner.vercel.app')
    assert.equal(isSameOrigin(from('https://recompete-scanner.vercel.app')), true)
    // A trailing slash on the configured value must not matter; a string
    // comparison would refuse every form on such a deployment.
    assert.equal(isSameOrigin(from('https://recompete-scanner.vercel.app/')), true)
  })
})

test('a deployment refuses every other address, including its own other names', () => {
  withEnvironment(DEPLOYED, () => {
    const refused = [
      'https://recompete-scanner-canadian-recompete-radar.vercel.app',
      'https://recompete-scanner-git-main-canadian-recompete-radar.vercel.app',
      'https://recompete-scanner-9hsjvkkjm-canadian-recompete-radar.vercel.app',
      'https://evil.example',
      'http://recompete-scanner.vercel.app',
      'https://recompete-scanner.vercel.app.evil.example',
      'not a url',
      '',
    ]
    for (const origin of refused) {
      assert.equal(isSameOrigin(from(origin)), false, `${JSON.stringify(origin)} must be refused`)
    }
    assert.equal(isSameOrigin(from(null)), false, 'no Origin header at all must be refused')
  })
})

test('`Origin: null` is refused, which is what a no-referrer policy produces', () => {
  // The literal string a browser sends when the referrer policy is
  // `no-referrer`. This behaviour is correct and must stay; what must never
  // come back is a response header that makes browsers send it. See
  // next.config.ts and GROUND-TRUTH G28.
  withEnvironment(DEPLOYED, () => {
    assert.equal(isSameOrigin(from('null')), false)
  })
})

test('a deployment with a byte-order mark on APP_URL refuses everything, and says so by refusing its own address', () => {
  // GROUND-TRUTH G21. A value that cannot be parsed makes every origin fail,
  // including the right one. That is the signature that tells this apart from
  // an unset APP_URL, where the branch alias would be accepted instead.
  withEnvironment(
    { ...DEPLOYED, APP_URL: '﻿https://recompete-scanner.vercel.app' },
    () => {
      assert.equal(isSameOrigin(from('https://recompete-scanner.vercel.app')), false)
    },
  )
})

test('production with no APP_URL fails loudly instead of trusting the branch alias', () => {
  // GROUND-TRUTH G17. The platform always sets VERCEL_BRANCH_URL, so an
  // ungated fallback means the throw can never be reached and the site quietly
  // decides its origin is an address nobody browses, refusing every form. It
  // must throw instead, which fails the request with a sentence naming the
  // variable rather than serving a site whose every button is refused.
  withEnvironment(
    { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_BRANCH_URL: 'recompete-scanner-git-main.vercel.app' },
    () => {
      assert.throws(() => appUrl(), /APP_URL is not set/)
    },
  )
})

test('a preview deployment still uses the branch alias, because that is the only address it has', () => {
  withEnvironment(
    { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'recompete-scanner-git-x.vercel.app' },
    () => {
      assert.equal(appUrl(), 'https://recompete-scanner-git-x.vercel.app')
      assert.equal(isSameOrigin(from('https://recompete-scanner-git-x.vercel.app')), true)
      assert.equal(isSameOrigin(from('https://evil.example')), false)
    },
  )
})

test('on a developer machine both names for this computer are accepted', () => {
  // Measured on 6 September 2026: `next dev` prints and the README gives
  // http://localhost:PORT, while appUrl() answered http://127.0.0.1:PORT, and
  // an origin compares host as written. Pages rendered and every button
  // answered a bare Forbidden. That also broke the one method that catches the
  // G28 class of fault, which is driving a real form in a real browser.
  withEnvironment({ PORT: '3123' }, () => {
    assert.equal(appUrl(), 'http://127.0.0.1:3123')
    for (const origin of ['http://127.0.0.1:3123', 'http://localhost:3123', 'http://[::1]:3123']) {
      assert.equal(isSameOrigin(from(origin)), true, `${origin} must be accepted locally`)
    }
  })
})

test('the loopback allowance does not widen anything else', () => {
  withEnvironment({ PORT: '3123' }, () => {
    const refused = [
      'http://localhost:9999', // a different port is a different server
      'https://localhost:3123', // a different scheme
      'http://evil.example:3123',
      'http://localhost.evil.example:3123',
      'http://127.0.0.2:3123', // loopback range, but not a name for this machine
    ]
    for (const origin of refused) {
      assert.equal(isSameOrigin(from(origin)), false, `${origin} must still be refused`)
    }
  })
})

test('the loopback allowance is impossible on a deployment', () => {
  // The guard is the platform's own variable, not anything about the request,
  // so a deployed site can never be talked into accepting a loopback origin.
  for (const env of [
    { ...DEPLOYED, APP_URL: 'http://127.0.0.1:3123' },
    { VERCEL: '1', VERCEL_ENV: 'preview', APP_URL: 'http://127.0.0.1:3123' },
  ]) {
    withEnvironment(env, () => {
      assert.equal(isSameOrigin(from('http://localhost:3123')), false)
      assert.equal(isSameOrigin(from('http://127.0.0.1:3123')), true)
    })
  }
})
