// What a watchlist item is, and what may be stored as one.
//
// This file imports nothing, so a .mjs check can load it directly and so the
// rules below cannot drift from something else's idea of them.
//
// ## The two key shapes, and why they are these
//
// Measured on 5 September 2026 against the 25,208 live contracts in the
// pipeline the public site is built from:
//
//   * `reference_number` alone is NOT unique. 13,300 distinct values across
//     25,208 rows; 3,537 reference numbers are held by more than one
//     department, covering 15,445 rows. `C-2025-2026-Q2-00018` belongs to ten
//     departments at once, with different values and different expiry dates.
//     A contract watched by reference number alone would be nine parts wrong.
//   * `(buyer_org_code, reference_number)` IS unique: 25,208 pairs for 25,208
//     rows, both fields populated on every row.
//   * That same pair is what the government's own record page is addressed by,
//     so a stored key reconstructs a link the person can check for themselves.
//   * `procurement_id` is stable across amendments and was considered instead.
//     It was rejected because its values carry spaces, brackets, pipes and
//     backslashes (`HABVA68-87170 CN`), it appears nowhere on the public site,
//     and it addresses no public page. A key nobody can verify is the wrong
//     key for a product whose whole claim is that its numbers can be checked.
//
// **The consequence, which Iteration 2 must handle.** Each amendment of a
// contract carries its own reference number, and the pipeline keeps the latest,
// so the reference number shown for a contract changes when it is next amended.
// 23% of live contracts have been amended at least once. A stored key therefore
// names the contract as it stood when the person pressed Watch. The scanner
// diffs consecutive snapshots keyed on the ingest's own `contract_key`, so it
// sees both the old and the new reference number in the same diff, and must
// carry a watch forward when it observes that change. That is the same
// observation that produces an EXPIRY_MOVED event, so a scanner that cannot do
// it cannot emit that event either. This is written into MILESTONES M2.
//
//   * `vendor_key` is the ingest's normalised supplier identity: the published
//     name lowercased, punctuation replaced by spaces, legal-form and geography
//     words removed. 10,498 distinct on live rows. Every one matches the vendor
//     pattern below; length 2 to 101.
//
// Both patterns were run against all 25,208 rows on 5 September 2026 and
// refused none of them. Refusing a real key would mean a Watch button on the
// public site that silently does nothing, so that measurement is the point of
// the patterns rather than a nicety.
//
// ## What a vendor key is, for anyone reading this later
//
// A vendor key is a normalised **name**, not a code. `lumina it` is
// recognisably LUMINA IT INC. Two things follow. The privacy policy says so
// plainly rather than calling the whole watchlist "reference codes". And when
// Iteration 2 brings supplier names into the app, a key must pass through the
// same fail-closed suppression gate as a name before it is rendered anywhere
// other than back to the person who stored it: the public site blanks the
// vendor key of a private individual before it builds any page, but the
// pipeline the scanner reads does not, so individuals' keys exist in the data.

/** The two things a person can follow. `vendor` is the schema's word; the interface says supplier. */
export type WatchKind = 'contract' | 'vendor'

export type WatchTarget = { kind: WatchKind; key: string }

/**
 * The most a single person may watch.
 *
 * A limit exists so one account cannot fill the table, and it is a round
 * number said out loud on screen rather than a silent refusal. Nobody
 * following the whole federal contract pipeline is using this product as
 * intended, and the digest at Iteration 4 has to be readable.
 */
export const MAX_WATCH_ITEMS = 200

/**
 * A department code as the contract pipeline writes it: `ic`, `dnd-mdn`,
 * `pwgsc-tpsgc`. Measured: 92 distinct codes, longest 14 characters, drawn
 * only from lowercase letters, digits and hyphens.
 */
const ORG_CODE = /^[a-z0-9-]{1,40}$/

/**
 * A contract reference number.
 *
 * Measured: longest 30 characters; none contains whitespace; 33 of them carry
 * a non-breaking hyphen (U+2011) rather than an ASCII one, all from Employment
 * and Social Development Canada; two contain lowercase letters
 * (`Contracts-TBS-Historical-02443`). So letters, digits, hyphen of either
 * kind, underscore, dot and slash are accepted, and whitespace, commas and
 * everything else are not. The comma matters: it is the delimiter between the
 * two halves of a contract key, so a reference number carrying one could
 * forge a key for another department.
 */
const REFERENCE_NUMBER = /^[\p{L}\p{N}\-_./\u2011]{1,60}$/u

/**
 * A normalised supplier identity, exactly as the ingest produces it: groups of
 * letters and digits separated by single spaces. Accented and non-Latin
 * letters are ordinary here; `\p{L}` covers them, and a naive `[a-z0-9 ]`
 * would refuse 26 different accented and Greek characters that appear in real
 * supplier names.
 */
const VENDOR_KEY = /^[\p{L}\p{N}]+( [\p{L}\p{N}]+)*$/u

/** The longest key the database column accepts; see watch_items_target_len. */
const MAX_KEY_LENGTH = 200

/**
 * Turn whatever arrived from a query string or a form into a watch target, or
 * return null.
 *
 * Both parameters are `unknown` on purpose. A repeated query parameter arrives
 * as an array in this framework (`?key=a&key=b` gives `['a','b']`), and
 * `FormData.get` returns `string | File | null`. A regex test on an array
 * quietly stringifies it, so `?key=ic&key=C-2025-2026-Q1-00127` would join to
 * `ic,C-2025-2026-Q1-00127` and pass a check written for strings, and a
 * missing value would stringify to the word `undefined` and be stored as a
 * supplier nobody can ever match. Refusing anything that is not a string
 * before the first regex runs is what stops both.
 */
export function parseWatchTarget(kind: unknown, key: unknown): WatchTarget | null {
  if (typeof kind !== 'string' || typeof key !== 'string') return null
  if (kind !== 'contract' && kind !== 'vendor') return null
  if (key.length < 2 || key.length > MAX_KEY_LENGTH) return null

  if (kind === 'vendor') {
    // Lowercase is tested by comparison rather than by a character class.
    // `\p{Ll}` would have been the obvious way and is wrong: it refuses every
    // script that has no case at all, so a supplier registered in Chinese or
    // Japanese would be unwatchable. Comparing the key with its own lowercase
    // form is the ingest's own rule, and it leaves caseless scripts alone.
    if (key !== key.toLowerCase()) return null
    return VENDOR_KEY.test(key) ? { kind, key } : null
  }

  // Exactly one comma, so the two halves cannot be confused with each other.
  const comma = key.indexOf(',')
  if (comma < 0 || key.indexOf(',', comma + 1) !== -1) return null
  const org = key.slice(0, comma)
  const reference = key.slice(comma + 1)
  if (!ORG_CODE.test(org) || !REFERENCE_NUMBER.test(reference)) return null
  return { kind, key }
}

/** The two halves of a contract key. Call only with a key parseWatchTarget accepted. */
export function splitContractKey(key: string): { org: string; reference: string } {
  const comma = key.indexOf(',')
  return { org: key.slice(0, comma), reference: key.slice(comma + 1) }
}

/**
 * The government's own published record for a contract.
 *
 * The comma is the delimiter inside one path segment rather than part of
 * either value, so it is written percent-encoded and both values are encoded
 * with nothing left safe. The public site builds the same address from the
 * same two fields; six of six spot checks resolved to the right contract when
 * that was added there.
 */
export function governmentRecordUrl(key: string): string {
  const { org, reference } = splitContractKey(key)
  return `https://search.open.canada.ca/contracts/record/${encodeURIComponent(org)}%2C${encodeURIComponent(reference)}`
}

/** The address of the page that offers to watch one thing. */
export function watchPath(target: WatchTarget): string {
  return `/watch?kind=${encodeURIComponent(target.kind)}&key=${encodeURIComponent(target.key)}`
}

// The empty state lives in src/components/nothing-watched.tsx rather than here,
// because its second sentence carries a link in the middle and so has to be
// markup rather than a string. Two pages show it and neither writes it out.

/**
 * What a person is told when they press Watch.
 *
 * The second half is the same promise the privacy policy makes in the same
 * words, because a page that quietly implied alerts were running would be the
 * easier sentence and the wrong one.
 */
export const WATCH_EXPLAINER =
  'This saves it to your watchlist. Nothing is sent to you yet; alerts are not switched on in this release.'

/**
 * What a supplier key is, said in plain words wherever one is shown.
 *
 * An earlier draft said "as it appears in the published records, normalised",
 * which is two contradictory claims in one line and jargon in the middle of
 * them. It is not as it appears; that is the whole point of it.
 */
export const SUPPLIER_KEY_NOTE =
  'This is a simplified form of the supplier name as published. Capitals, punctuation and words such as Inc or Ltd are removed, so different spellings of one supplier are treated as one.'

/** "1 contract", "2 contracts". */
export function countNoun(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`
}

/**
 * "You are watching 5 contracts and 2 suppliers."
 *
 * A kind with nothing in it is left out rather than printed as a zero, because
 * "5 contracts and 0 suppliers" reads as a fault. Both being zero is handled by
 * the caller, which shows the empty state instead.
 */
export function watchingSentence(contracts: number, vendors: number): string {
  const parts: string[] = []
  if (contracts > 0) parts.push(countNoun(contracts, 'contract'))
  if (vendors > 0) parts.push(countNoun(vendors, 'supplier'))
  return `You are watching ${parts.join(' and ')}.`
}
