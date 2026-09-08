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
 * The caption on a watched contract: who the supplier is, and which department.
 *
 * **This is not identity and must never be used as any.** `WatchTarget` is
 * identity; this is what a row says on screen. They are two types rather than
 * four fields on one type precisely so that nothing can drift into looking a
 * row up by its caption: every function that identifies a watch item takes a
 * `WatchTarget` and cannot be handed one of these by mistake.
 *
 * Both halves are optional and were absent until 0003_watch_labels.sql. Every
 * row written before it has neither, and a Watch link can arrive without them
 * from an old bookmark or a hand-typed address.
 *
 * The values are CALLER-CONTROLLED. They arrive as `&name=` and `&dept=` on a
 * URL, so anyone can put anything in them. They reach nobody but the one person
 * whose watchlist it is, which makes the blast radius one screen, but they are
 * still capped here and escaped on output.
 */
export type WatchLabels = { name: string | null; dept: string | null }

/** Neither label known. What a caller passes when there is nothing to say. */
export const NO_LABELS: WatchLabels = { name: null, dept: null }


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

/**
 * The most a stored label may be. Matches the CHECK constraints added in
 * 0003_watch_labels.sql; tests/watch-labels.test.mjs asserts the two agree by
 * writing a value of exactly this length to the real database, rather than by
 * trusting this sentence.
 *
 * Two hundred is a safety limit, not a working one. The longest vendor_key over
 * 25,208 live contracts was 101 characters and the longest department name is
 * far shorter, so nothing real is ever truncated by it.
 */
export const MAX_LABEL_LENGTH = 200

/**
 * Turn whatever arrived as `&name=` and `&dept=` into the caption for a row.
 *
 * Never returns null and never throws: a label that cannot be used is simply
 * absent, and the watchlist has a sentence for an absent one. A parse that
 * could fail would make an unreadable caption able to stop somebody watching a
 * contract, which is the wrong trade in every case.
 *
 * `kind` is taken so that the contract-only rule is enforced in one place
 * rather than remembered by each of the five callers. A supplier is identified
 * by its vendor_key, which already IS its display name; a second name for it
 * could only ever disagree with the first. The same rule is a CHECK constraint
 * in the database, because a rule that lives only here is not a rule.
 */
export function parseWatchLabels(kind: unknown, name: unknown, dept: unknown): WatchLabels {
  if (kind !== 'contract') return NO_LABELS
  return { name: cleanLabel(name), dept: cleanLabel(dept) }
}

/**
 * One label, made safe to store and print, or null.
 *
 * Three things happen here and each is load-bearing:
 *
 *  1. **Control and format characters go.** `\p{Cc}` is the C0/C1 controls, so a
 *     newline cannot break a one-line caption into two. `\p{Cf}` is the format
 *     characters, which matters more than it looks: U+202E RIGHT-TO-LEFT
 *     OVERRIDE reverses everything printed after it, so a label carrying one
 *     could make a row read as a supplier it is not. Runs of these and of
 *     ordinary whitespace collapse to a single space.
 *  2. **Empty becomes null**, so `&name=` with nothing after it is the same as
 *     no parameter at all rather than a caption that prints as a blank line.
 *  3. **The cap is applied last**, and a trailing lone surrogate is removed
 *     after it. Cutting a string at a fixed number of UTF-16 units can split a
 *     surrogate pair, and Postgres refuses a lone surrogate as an invalid byte
 *     sequence, which would be a 500 on insert rather than a shortened caption.
 *     Slicing by UTF-16 units also cannot exceed the constraint's count of
 *     characters, because a code point is never fewer than one unit.
 *
 * Escaping is NOT done here. React escapes text children by default, and a
 * value escaped twice prints its own entities.
 */
function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const collapsed = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()
  if (collapsed === '') return null
  const capped = collapsed.slice(0, MAX_LABEL_LENGTH).replace(/[\uD800-\uDBFF]$/, '').trim()
  return capped === '' ? null : capped
}

/** The query-string half of a watch address: the target, then any labels. */
function watchQuery(target: WatchTarget, labels: WatchLabels): string {
  let q = `kind=${encodeURIComponent(target.kind)}&key=${encodeURIComponent(target.key)}`
  // Re-cleaned rather than trusted, for the same reason the target is re-parsed
  // at every hop: nothing is written onward that has not just been validated.
  const { name, dept } = parseWatchLabels(target.kind, labels.name, labels.dept)
  if (name !== null) q += `&name=${encodeURIComponent(name)}`
  if (dept !== null) q += `&dept=${encodeURIComponent(dept)}`
  return q
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

/**
 * The address of the page that offers to watch one thing.
 *
 * Labels ride along so that a person who signed in on the way here still sees
 * which supplier the contract belongs to when they arrive. They default to
 * none, which is what a caller with nothing to say passes and what every caller
 * passed before labels existed.
 */
export function watchPath(target: WatchTarget, labels: WatchLabels = NO_LABELS): string {
  return `/watch?${watchQuery(target, labels)}`
}

/**
 * Carry "what this person was trying to watch" across the sign-in flow.
 *
 * Someone presses Watch on recompeteradar.ca, is not signed in, and is sent to
 * sign in. Without this, the thing they pressed is forgotten: they confirm the
 * emailed link, land on an empty feed, and have to go back to the site and find
 * it again. Most people will conclude it did not work.
 *
 * **The target is rebuilt at every hop, never echoed.** Each of the four places
 * this passes through re-reads `kind` and `key` with `parseWatchTarget` and
 * calls this function or `watchPath` to write them out again, so a value that
 * would not survive validation cannot travel. That is what stops this becoming
 * an open redirect: no caller can put an arbitrary destination into it, because
 * no caller supplies a destination at all. The only paths it can ever produce
 * are `/sign-in` and `/watch` on this origin.
 *
 * A null target returns the path unchanged, which is the ordinary case of
 * somebody signing in without having pressed Watch first.
 */
export function withWatchTarget(
  path: string,
  target: WatchTarget | null,
  labels: WatchLabels = NO_LABELS,
): string {
  if (target === null) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}${watchQuery(target, labels)}`
}

/**
 * What the sign-in page says when it knows where the person was going.
 *
 * Named rather than written inline because the sign-in page and the confirm
 * page both show it, and a promise made in two places has to be the same
 * promise. It says "after you sign in", not "now", because that is when it
 * happens.
 */
export const RETURNING_TO_WATCH_NOTE =
  'After you sign in we will take you back to what you were about to watch.'

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
 * What a watched contract says when no supplier name was stored with it.
 *
 * Two rows get this: every row saved before 0003_watch_labels.sql, and any row
 * added from a Watch link that carried no `&name=` — an old bookmark, or a
 * hand-typed address. There is nothing to backfill from, because this
 * application holds no contract data until the scanner lands at M2.
 *
 * It says what to do rather than only what is missing, and the instruction
 * works: pressing Watch again from the site fills the label in on the existing
 * row rather than refusing as a duplicate. See the insert in /watch/add.
 *
 * The name is not guessed from the reference number and must not be. There is
 * nothing in this application to guess from, and a guessed supplier name on a
 * contract somebody is watching would be worse than an absent one.
 */
export const NO_CONTRACT_LABEL_NOTE =
  'No supplier name was saved with this one. Press Watch on it again from recompeteradar.ca, and you will be offered the name to add.'

/**
 * What the watch page says to somebody already watching a contract, arriving
 * from a link that carries a supplier name their saved row does not have.
 *
 * This exists because the sentence above was a lie for two hours. It told
 * people to press Watch again, and pressing Watch again landed them on a page
 * that said "You are already watching this" and offered only Stop watching:
 * there was no way to accept the name. The tests did not catch it because they
 * post to /watch/add directly; opening the page in a browser did.
 */
export const ADD_NAME_OFFER =
  'This came with a supplier name, and the copy you saved has none. Adding it changes nothing else about what you follow.'

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
