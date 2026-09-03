// The one way the application reaches the database.
//
// The client is built lazily, inside the function, never at module load. A
// client constructed at import time would need DATABASE_URL during `next build`,
// where no database is reachable, and would fail the build rather than the
// request.
//
// Every error leaving this file is a DatabaseError carrying nothing but a
// SQLSTATE code and a constraint name. The driver's own error is discarded here
// and never propagates, because Postgres puts the offending row value in its
// `detail` field; measured on 2 September 2026 as
// `Key (email)=(someone@example.com) already exists`.

import { neon } from '@neondatabase/serverless'
import { requireEnv } from './env'
import { errorFacts } from './log'

/**
 * Thrown for every database failure. Carries no message from Postgres, on
 * purpose. Callers decide what a person is shown; they never show this.
 */
export class DatabaseError extends Error {
  readonly code?: string
  readonly constraintName?: string

  constructor(facts: { code?: string; constraint?: string }) {
    super('database query failed')
    this.name = 'DatabaseError'
    this.code = facts.code
    this.constraintName = facts.constraint
  }
}

let cached: ReturnType<typeof neon> | undefined

function getSql() {
  if (!cached) cached = neon(requireEnv('DATABASE_URL'))
  return cached
}

/**
 * Run one parameterised statement and return its rows.
 *
 * Values are always passed as parameters, never interpolated into the SQL, so
 * the statement text is fixed at author time and cannot be shaped by input.
 */
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    const sql = getSql()
    const rows = await sql.query(text, params)
    return rows as T[]
  } catch (err) {
    // The original error stops here. Only the two safe facts continue.
    throw new DatabaseError(errorFacts(err))
  }
}

/** Run a statement expected to return at most one row. */
export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params)
  return rows[0]
}
