// Turning what someone typed into the exact string the database will accept.
//
// This function and the database's CHECK constraints must accept precisely the
// same set of addresses. That is not tidiness; it is the difference between a
// working product and a person locked out for good.
//
// If this function were the more permissive of the two, an address would pass
// here, be issued a sign-in link, be emailed, and then fail on the users insert
// after the link had already been spent. That person could repeat the loop for
// ever and never get in, and nothing in the interface would explain why.
//
// The constraint in db/migrations/0001_init.sql is:
//
//     email = lower(btrim(email))
//     AND email LIKE '%_@_%.__%'
//     AND char_length(email) BETWEEN 6 AND 254
//
// Read the LIKE pattern as: at least one character, an at sign, at least one
// character, a dot, then at least two more characters. Measured against the live
// database on 2 September 2026: it rejects `abc@d.e` and `a@b.c`, and accepts
// `ab@c.de`. The `{2,}` below is what makes this regex agree; a more usual
// `\.[^\s@]+$` would accept `abc@d.e` and reintroduce the lockout.
//
// tests/email-agreement.test.mjs asserts the agreement by running hundreds of
// addresses through both this function and the real constraint, rather than by
// trusting this comment.

/** Returns the storable form of an address, or null if it is not acceptable. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const s = input.trim().toLowerCase()
  if (s.length < 6 || s.length > 254) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return null
  return s
}
