// A stand-in for Resend's API, so the real send path can be executed without an
// account, a key, or a message reaching anybody.
//
// It exists because of a gap found on 5 September 2026: the send path in
// src/lib/email.ts had never been run by anything. Every check in the suite sets
// EMAIL_DRY_RUN=1, which returns before the HTTP call, so the fetch, the
// headers, the request body and all three failure branches were unexecuted code
// on the day they were due to run for the first time against a live key.
//
// The stub records what it was sent rather than asserting anything itself. The
// checks do the asserting, so this file has no opinion to get wrong.

import { createServer } from 'node:http'

/**
 * Start a stub on an ephemeral port.
 *
 * @param {{status?: number, body?: string}} [reply]
 *   What to answer with. Defaults to Resend's shape for a successful send.
 */
export async function startResendStub(reply = {}) {
  const status = reply.status ?? 200
  const body = reply.body ?? JSON.stringify({ id: 'stub-message-id' })

  /** Every request received, in order. */
  const received = []

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Recorded as null. A check asserting on the body will say so plainly
        // rather than failing here with a parse error from the wrong file.
      }
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        raw,
        body: parsed,
      })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    /** What src/lib/email.ts should be pointed at via RESEND_BASE_URL. */
    url: `http://127.0.0.1:${port}/emails`,
    received,
    async stop() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
