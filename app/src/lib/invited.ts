// Sign-in, closed to an invited list while the watchlist is being tested.
//
// ## Why this exists
//
// Before this, `POST /auth/request` sent a link to any address that parsed, and
// that address then had a working account and a watchlist. The watchlist is to
// be a paid feature after testing, so until then only the four invited testers
// and Jon should be able to get in.
//
// ## When it comes out
//
// **This whole file is deleted when the product starts charging**, or it becomes
// a paid-subscriber check in the same shape. It is one module with two exports
// and one call site each — the refusal in `auth/request/route.ts` and the notice
// on `sign-in/page.tsx` — so removing it is a small, complete change rather than
// an archaeology exercise.
//
// ## The list is personal data
//
// Four testers' addresses are personal data under MASTER-DESIGN rule 8. They
// live in the Vercel Production environment and in the git-ignored `.env.local`,
// **never in this repository and never in a log**. Nothing here writes an
// address anywhere: `lib/log.ts` allows only an allowlisted set of field names
// and drops any string containing an at sign, so even a mistake here could not
// print one, and the counts below are the only part that would survive.
//
// ## A measured note on the byte-order mark
//
// `docs/ENVIRONMENT.md` and GROUND-TRUTH G21 record that piping a value into
// `vercel env add` from PowerShell stores it with a UTF-8 byte-order mark, which
// is what made `APP_URL` answer 403 to every form. This variable survives that
// mistake: U+FEFF is JavaScript whitespace, so `String.prototype.trim` removes
// it and the first address parses anyway. Measured 7 September 2026, not
// assumed. That is luck rather than design, and the `cmd` redirect in
// `docs/ENVIRONMENT.md` is still the way to set it.

import { optionalEnv } from './env'
import { normalizeEmail } from './normalize-email'
import { log } from './log'

/**
 * The standing notice on the sign-in page, shown before anyone types.
 *
 * It lives in this file rather than beside the other sentences in
 * `sign-in/page.tsx` so that the notice and the refusal are one thing. Deleting
 * this module at launch takes both away together; a notice left behind would go
 * on telling people the product is in testing after it is not.
 *
 * **It is shown whenever this module exists, not when `INVITED_EMAILS` is set.**
 * That is deliberate and it is the only reading that is true. The gate fails
 * closed: an unset variable refuses everybody, so an unset variable is the gate
 * at its most restrictive, not the gate switched off. Tying the notice to the
 * variable would hide it in exactly the state where it is most needed — a
 * redeploy that lost the variable, where every visitor is being refused and none
 * of them is told why. The gate goes away when the code goes away.
 *
 * One sentence, and no third clause. It does not apologise and does not invite
 * people to ask for access, because Jon has not said he wants those requests.
 */
export const INVITED_ONLY_NOTICE =
  'The watchlist is being tested before its full release, so sign in is limited to invited testers right now.'

/**
 * Is this address on the invited list?
 *
 * Takes an address that has ALREADY been through `normalizeEmail` — in practice
 * the route's own `email` — and puts every entry of the variable through the
 * same function, so both sides of the comparison are normalised identically and
 * the comparison itself is exact. Splitting on commas, trimming, and dropping
 * empty segments means a trailing comma, stray spaces and mixed case in the
 * variable all work.
 *
 * **Unset refuses everybody.** Failing open would mean a redeploy that lost the
 * variable silently reopening sign-in to the world, which is the failure nobody
 * would notice until it mattered. `sign_in_allowlist_missing` in the logs is the
 * only thing that would say so.
 *
 * `optionalEnv` rather than `requireEnv`, on purpose. `requireEnv` throws, the
 * throw is outside the route's error handling, and `POST /auth/request` would
 * answer a bare 500 — the failure mode `docs/ENVIRONMENT.md` records for
 * `EMAIL_FROM`. A refusal page that says what happened is worth more than a 500.
 *
 * An entry that will not parse is counted and logged rather than dropped in
 * silence. A typo in the variable would otherwise lock a tester out with nothing
 * anywhere to explain it. The entry itself is never logged.
 *
 * Nothing is cached. The variable cannot change under a running server, the list
 * has five entries, and a cache would be a second piece of state to be wrong.
 */
export function isInvited(normalisedEmail: string): boolean {
  const raw = optionalEnv('INVITED_EMAILS')
  if (raw === undefined) {
    log({ event: 'sign_in_allowlist_missing' })
    return false
  }

  const invited = new Set<string>()
  let unparseable = 0
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const normalised = normalizeEmail(trimmed)
    if (normalised === null) {
      unparseable += 1
      continue
    }
    invited.add(normalised)
  }

  if (unparseable > 0) {
    // The count and nothing else. log() would drop the entry anyway.
    log({ event: 'sign_in_allowlist_entry_invalid', count: unparseable })
  }

  return invited.has(normalisedEmail)
}
