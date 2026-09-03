// Random values for sign-in links and sessions.
//
// There is no password anywhere in this system, so there is no password hash,
// no salt, and no slow hashing function. A token is 256 bits of randomness; the
// SHA-256 is there only so that reading the database does not yield a usable
// credential. Guessing one is not a threat worth slowing down for.
//
// Nothing in JavaScript ever compares two secrets to each other. Lookup happens
// in SQL by hash equality, so there is no place a timing comparison could go.

import { createHash, randomBytes } from 'node:crypto'

/** A fresh secret: 32 random bytes as 43 base64url characters. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The digest stored in the database.
 *
 * It digests the 43-character text, not the 32 raw bytes. Anything that seeds a
 * token row in a test must hash the same way or it will look up nothing.
 */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Cheap shape check, so a malformed value never reaches a query. */
export function isTokenShaped(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}
