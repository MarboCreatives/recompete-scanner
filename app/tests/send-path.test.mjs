// Executes the real Resend send path in src/lib/email.ts, against a stub.
//
// Why this file exists. On 5 September 2026 the send path had never been run by
// anything. All 41 checks set EMAIL_DRY_RUN=1, which returns at the top of
// sendEmail, so everything below that — the key lookup, the EMAIL_FROM lookup,
// the production guard, the fetch, the headers, the body and all three failure
// branches — was code whose first execution would have been a live sign-in
// attempt on the production site with a real key.
//
// The check that found the gap is the one at the bottom of this file: the send
// path reads EMAIL_FROM, which is set in no environment. HANDOFF said setting
// RESEND_API_KEY would close M0. It would instead have produced a 500 on the
// first sign-in, because requireEnv throws and the throw is outside the
// DatabaseError handling in the request route.
//
// No database and no running server are needed here, deliberately. The flow
// test already drives the route over HTTP; what was missing was coverage of the
// module it calls. Needing neither means this file can run in CI before any
// secret is configured.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkHookWorks, installTypeScriptResolver, libUrl } from './ts-resolve.mjs'
import { startResendStub } from './resend-stub.mjs'

installTypeScriptResolver()
const { sendEmail } = await import(libUrl('email.ts'))

/** An address that must never appear in anything written down. */
const ADDRESS = 'someone@example.com'

const MESSAGE = {
  to: ADDRESS,
  subject: 'Your sign-in link',
  text: 'Open this link: https://example.test/sign-in/verify?token=abc',
  html: '<p>Open this link</p>',
  idempotencyKey: 'sign-in/abc123',
}

/** The variables sendEmail reads. Every case starts from a known state. */
const KEYS = [
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'RESEND_BASE_URL',
  'EMAIL_DRY_RUN',
  'VERCEL_ENV',
]

/**
 * Run a body with exactly the given variables set, restoring the environment
 * afterwards even when the body throws.
 */
async function withEnv(vars, body) {
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(vars)) process.env[k] = v
  try {
    return await body()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** Capture everything the logger writes while the body runs. */
async function capturingOutput(body) {
  const written = []
  const realLog = console.log
  const realError = console.error
  console.log = (...args) => written.push(args.join(' '))
  console.error = (...args) => written.push(args.join(' '))
  try {
    const value = await body()
    return { value, output: written.join('\n') }
  } finally {
    console.log = realLog
    console.error = realError
  }
}

test('the TypeScript resolver this file depends on actually resolves', async () => {
  // If this fails, every other case here is meaningless, so it is asserted
  // first and on its own rather than left implicit in the import above.
  await checkHookWorks()
})

test('a real send makes one POST carrying the key, the idempotency key and the message', async () => {
  const stub = await startResendStub()
  try {
    const result = await withEnv(
      {
        RESEND_API_KEY: 'test-key-not-a-real-one',
        EMAIL_FROM: 'Recompete Scanner <notifications@example.test>',
        RESEND_BASE_URL: stub.url,
      },
      () => sendEmail(MESSAGE),
    )

    assert.deepEqual(result, { ok: true }, 'a 200 from the API is a successful send')
    assert.equal(stub.received.length, 1, 'exactly one request was made')

    const [req] = stub.received
    assert.equal(req.method, 'POST')
    assert.equal(
      req.headers.authorization,
      'Bearer test-key-not-a-real-one',
      'the key travels as a bearer token',
    )
    assert.equal(
      req.headers['idempotency-key'],
      'sign-in/abc123',
      'the idempotency key is sent, so a retry cannot send twice',
    )
    assert.match(req.headers['content-type'], /application\/json/)

    assert.equal(req.body.from, 'Recompete Scanner <notifications@example.test>')

    // The From address lives on the verified sending subdomain, which has no MX
    // record — measured 8 September 2026 — so a reply to it bounces. A tester
    // replying to the first message this product ever sends them is an ordinary
    // thing to do, and there is no other way to reach anybody from inside the
    // product. This routes replies to the apex, which has mail forwarding.
    //
    // Written out rather than imported from email-templates.ts, because a check
    // that asks the code under test for the right answer cannot notice the code
    // being wrong. CODING-STANDARDS 2.4.
    assert.equal(
      req.body.reply_to,
      'hello@recompeteradar.ca',
      'a reply must reach a mailbox that exists',
    )

    assert.deepEqual(req.body.to, [ADDRESS], 'the recipient is sent as an array')
    assert.equal(req.body.subject, MESSAGE.subject)
    assert.equal(req.body.text, MESSAGE.text)
    assert.equal(req.body.html, MESSAGE.html)
  } finally {
    await stub.stop()
  }
})

test('EMAIL_FROM missing throws, and the message names the variable', async () => {
  // This is the fault the whole file was written to catch. With the key set and
  // EMAIL_FROM unset, which is exactly the state that setting RESEND_API_KEY
  // alone would create, requireEnv throws and POST /auth/request answers 500.
  const stub = await startResendStub()
  try {
    await assert.rejects(
      () =>
        withEnv(
          { RESEND_API_KEY: 'test-key-not-a-real-one', RESEND_BASE_URL: stub.url },
          () => sendEmail(MESSAGE),
        ),
      (err) => {
        assert.match(err.message, /EMAIL_FROM/, 'the error must name the missing variable')
        assert.match(err.message, /docs\/ENVIRONMENT\.md/, 'and say where the list is')
        return true
      },
    )
    assert.equal(stub.received.length, 0, 'nothing was sent')
  } finally {
    await stub.stop()
  }
})

test('with no API key, nothing is sent and no address is written down', async () => {
  const stub = await startResendStub()
  try {
    const { value, output } = await capturingOutput(() =>
      withEnv(
        { EMAIL_FROM: 'x <notifications@example.test>', RESEND_BASE_URL: stub.url },
        () => sendEmail(MESSAGE),
      ),
    )
    assert.equal(value.ok, false, 'a missing key is a failed send, not a silent success')
    assert.equal(stub.received.length, 0, 'no request was attempted')
    assert.match(output, /send_skipped_no_api_key/, 'it says which setting is missing')
    assert.ok(!output.includes(ADDRESS), 'no address reaches the output')
  } finally {
    await stub.stop()
  }
})

test('a dry run sends nothing at all', async () => {
  const stub = await startResendStub()
  try {
    const { value, output } = await capturingOutput(() =>
      withEnv(
        {
          EMAIL_DRY_RUN: '1',
          RESEND_API_KEY: 'test-key-not-a-real-one',
          EMAIL_FROM: 'x <notifications@example.test>',
          RESEND_BASE_URL: stub.url,
        },
        () => sendEmail({ ...MESSAGE, dryRunUrl: 'https://example.test/link' }),
      ),
    )
    assert.deepEqual(value, { ok: true })
    assert.equal(stub.received.length, 0, 'a dry run must not reach the API even with a key set')
    assert.ok(!output.includes(ADDRESS), 'the dry-run line carries the link, never the address')
  } finally {
    await stub.stop()
  }
})

test('a refusal from the API is reported without echoing the address back', async () => {
  // Resend's error bodies name the recipient, and with the test sender they say
  // outright which address owns the account. email.ts does not read the body;
  // this proves it, by putting the address in the body and asserting it does
  // not come out anywhere.
  const stub = await startResendStub({
    status: 422,
    body: JSON.stringify({
      statusCode: 422,
      message: `You can only send testing emails to your own address (${ADDRESS})`,
    }),
  })
  try {
    const { value, output } = await capturingOutput(() =>
      withEnv(
        {
          RESEND_API_KEY: 'test-key-not-a-real-one',
          EMAIL_FROM: 'x <notifications@example.test>',
          RESEND_BASE_URL: stub.url,
        },
        () => sendEmail(MESSAGE),
      ),
    )
    assert.equal(value.ok, false)
    assert.equal(value.status, 422, 'the status is kept, because it is not personal data')
    assert.ok(!output.includes(ADDRESS), 'the refusal body must not reach the output')
    assert.ok(!output.includes('own address'), 'no part of the refusal body is logged')
  } finally {
    await stub.stop()
  }
})

test('an unreachable API is a failed send, not a thrown error', async () => {
  const stub = await startResendStub()
  const dead = stub.url
  await stub.stop()

  const { value, output } = await capturingOutput(() =>
    withEnv(
      {
        RESEND_API_KEY: 'test-key-not-a-real-one',
        EMAIL_FROM: 'x <notifications@example.test>',
        RESEND_BASE_URL: dead,
      },
      () => sendEmail(MESSAGE),
    ),
  )
  assert.equal(value.ok, false, 'a network failure must not throw out of sendEmail')
  assert.match(output, /send_error/)
  // A fetch failure message can carry the whole request URL, which is why
  // email.ts catches without logging the error.
  assert.ok(!output.includes(ADDRESS))
})

test('RESEND_BASE_URL is refused outright on a production deployment', async () => {
  // Left set in production it would send every sign-in link to a test endpoint,
  // silently. Failing loudly is the whole point, so it is asserted.
  const stub = await startResendStub()
  try {
    await assert.rejects(
      () =>
        withEnv(
          {
            VERCEL_ENV: 'production',
            RESEND_API_KEY: 'test-key-not-a-real-one',
            EMAIL_FROM: 'x <notifications@example.test>',
            RESEND_BASE_URL: stub.url,
          },
          () => sendEmail(MESSAGE),
        ),
      /RESEND_BASE_URL is set on a production deployment/,
    )
    assert.equal(stub.received.length, 0, 'nothing was sent to the stub')
  } finally {
    await stub.stop()
  }
})

test('a dry run is refused outright on a production deployment', async () => {
  // The mirror of the case above: a dry run on the live site would mean people
  // asking for links, never receiving them, and the links sitting in a log.
  await assert.rejects(
    () =>
      withEnv(
        {
          VERCEL_ENV: 'production',
          EMAIL_DRY_RUN: '1',
          RESEND_API_KEY: 'test-key-not-a-real-one',
          EMAIL_FROM: 'x <notifications@example.test>',
        },
        () => sendEmail(MESSAGE),
      ),
    /EMAIL_DRY_RUN is set on a production deployment/,
  )
})
