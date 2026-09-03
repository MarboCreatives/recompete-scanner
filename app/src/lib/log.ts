// The only logging path in the application. Nothing else calls console.
//
// This exists because of a measurement, not a worry. On 2 September 2026 a
// constraint violation on the live database returned, in the error's `detail`
// field:
//
//     Key (email)=(someone@example.com) already exists.
//     Failing row contains (3, MiXeD@example.com).
//
// The driver copies `detail`, `hint`, `where`, `constraint` and a dozen other
// Postgres fields onto the thrown error. An uncaught route-handler error is
// printed by the runtime with every own property expanded, so an unguarded
// throw writes a real person's address into the hosting logs. That breaks the
// rule that an email address never reaches a log.
//
// The defence is an allowlist, not a blocklist. A blocklist protects against
// the fields someone thought of; an allowlist protects against the ones they
// did not.

/** Field names permitted in a log line. Anything else is dropped entirely. */
const ALLOWED_FIELDS = new Set([
  'event',
  'code',
  'constraint',
  'route',
  'status',
  'ms',
  'count',
  'reason',
])

/** No single value may be longer than this once stringified. */
const MAX_VALUE_LENGTH = 200

export type LogFields = Record<string, unknown>

/**
 * Reduce a value to something safe to write down.
 *
 * Returns undefined when the value must be dropped rather than redacted, so the
 * key disappears from the line instead of appearing with a placeholder that
 * might later be mistaken for real content.
 */
function safeValue(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined

  if (typeof value === 'string') {
    // An address is the thing we are most trying to keep out, and the cheapest
    // reliable signal for one is the at sign. A string carrying it is dropped
    // whole rather than masked, because a partial mask still leaks the domain.
    if (value.includes('@')) return undefined
    return value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) : value
  }

  // Objects, arrays, errors and functions are never logged. An object is how
  // an unexpected field smuggles itself in.
  return undefined
}

/**
 * Write one structured line. Only allowlisted field names survive, and only
 * after each value has been through safeValue.
 */
export function log(fields: LogFields): void {
  const safe: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) continue
    const cleaned = safeValue(value)
    if (cleaned === undefined) continue
    safe[key] = cleaned
  }
  // The single permitted console call in the application; see eslint.config.mjs.
  console.log(JSON.stringify(safe))
}

/**
 * Reduce any thrown value to the two things that are safe to record and useful
 * to read: the SQLSTATE code and the constraint name. Everything else the
 * driver attaches is discarded, including `message`, because a Postgres message
 * can carry the offending value.
 */
export function errorFacts(err: unknown): { code?: string; constraint?: string } {
  if (typeof err !== 'object' || err === null) return {}
  const e = err as Record<string, unknown>
  const facts: { code?: string; constraint?: string } = {}
  // A SQLSTATE code is five alphanumeric characters. Anything else is not one,
  // and is not passed through on the chance that it is.
  if (typeof e.code === 'string' && /^[0-9A-Za-z]{5}$/.test(e.code)) facts.code = e.code
  // A constraint name is chosen by this repository's own migration files, so it
  // never contains user input. The length cap is belt and braces.
  if (typeof e.constraint === 'string' && e.constraint.length <= 100) {
    facts.constraint = e.constraint
  }
  return facts
}
