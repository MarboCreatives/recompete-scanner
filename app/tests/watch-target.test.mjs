// What may be stored as a watchlist item, and what may not.
//
// No database and no server: this drives src/lib/watch.ts directly, so it runs
// anywhere, including a CI job with no secrets.
//
// The expected answers are written out here rather than derived from the code
// under test. That is CODING-STANDARDS 2.4: a check that asks the validator
// what the right answer is cannot notice the validator being wrong, which is
// how the main site's name-suppression audit was once fooled into passing.
//
// The accept list is not invented either. Every accepted case below is a shape
// measured in the real contract pipeline on 5 September 2026: the ordinary
// reference number, the non-breaking hyphen that 33 rows from Employment and
// Social Development Canada carry, the two rows whose reference contains
// lowercase words, the longest and shortest department codes, and supplier
// keys with accented and Greek letters. A validator that refused any of them
// would put a Watch button on the public site that silently does nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTypeScriptResolver, libUrl } from './ts-resolve.mjs'

installTypeScriptResolver()
const {
  parseWatchTarget,
  splitContractKey,
  governmentRecordUrl,
  watchingSentence,
  countNoun,
  MAX_WATCH_ITEMS,
} = await import(libUrl('watch.ts'))

const NB_HYPHEN = String.fromCharCode(0x2011)

const ACCEPTED_CONTRACTS = [
  ['ic,C-2025-2026-Q1-00127', 'the ordinary shape, from a real row'],
  ['dnd-mdn,C-2025-2026-Q2-00112', 'a hyphenated department code'],
  ['pwgsc-tpsgc,C-2024-2025-Q2-00078', 'the longest department code in the data'],
  [`esdc-edsc,C-2025${NB_HYPHEN}2026${NB_HYPHEN}Q2${NB_HYPHEN}00025`, 'the non-breaking hyphen 33 rows carry'],
  ['tbs-sct,Contracts-TBS-Historical-02443', 'the two rows whose reference has lowercase words'],
  ['pc,C-2026-2027-Q1-00248', 'a two-letter department code'],
]

const ACCEPTED_VENDORS = [
  ['lumina it', 'an ordinary normalised supplier'],
  ['bgis global integrated solutions', 'several words'],
  ['cae military aviation training', 'several words'],
  ['societe en commandite gaz metro', 'a French name with the accents already stripped by the ingest'],
  ['groupe deloitte s e n c r l', 'single letters, which the ingest produces from punctuation'],
  ['pecheries', 'one word'],
  ['dexterra', 'the shortest realistic key'],
  ['3m', 'digits'],
  ['alpha beta', 'plain letters'],
]

const REFUSED = [
  ['contract', 'C-2025-2026-Q1-00127', 'a bare reference number: it names up to ten different contracts'],
  ['contract', 'ic', 'a department code alone'],
  ['contract', 'ic,', 'no reference number'],
  ['contract', ',C-2025-2026-Q1-00127', 'no department code'],
  ['contract', 'ic,C-2025,00127', 'two commas: the halves could be confused'],
  ['contract', 'IC,C-2025-2026-Q1-00127', 'an uppercase department code, which the pipeline never writes'],
  ['contract', 'ic,C-2025 2026', 'whitespace in the reference number'],
  ['contract', 'ic C-2025', 'a space instead of the comma'],
  ['contract', 'ic,C<script>', 'markup characters'],
  ['contract', 'ic,' + 'A'.repeat(61), 'a reference number longer than any real one'],
  ['contract', 'a'.repeat(41) + ',C-1', 'a department code longer than any real one'],
  ['vendor', 'Lumina IT', 'uppercase: the ingest lowercases every key'],
  ['vendor', 'lumina  it', 'two spaces: the ingest collapses whitespace'],
  ['vendor', ' lumina it', 'a leading space'],
  ['vendor', 'lumina it ', 'a trailing space'],
  ['vendor', 'lumina-it', 'a hyphen: the ingest replaces punctuation with a space'],
  ['vendor', 'lumina.it', 'a dot'],
  ['vendor', 'someone@example.com', 'an at sign; no real key contains one'],
  ['vendor', 'a', 'one character, shorter than any real key'],
  ['vendor', 'a'.repeat(201), 'longer than the database column allows'],
  ['supplier', 'lumina it', 'a kind the schema does not have'],
  ['CONTRACT', 'ic,C-1', 'the kind is case sensitive'],
  ['', 'ic,C-1', 'an empty kind'],
]

test('every key shape measured in the real pipeline is accepted', () => {
  for (const [key, why] of ACCEPTED_CONTRACTS) {
    const got = parseWatchTarget('contract', key)
    assert.deepEqual(got, { kind: 'contract', key }, `contract key refused (${why}): ${key}`)
  }
  for (const [key, why] of ACCEPTED_VENDORS) {
    const got = parseWatchTarget('vendor', key)
    assert.deepEqual(got, { kind: 'vendor', key }, `vendor key refused (${why}): ${key}`)
  }
})

test('everything the pipeline could not have produced is refused', () => {
  for (const [kind, key, why] of REFUSED) {
    assert.equal(
      parseWatchTarget(kind, key),
      null,
      `should have been refused (${why}): kind=${JSON.stringify(kind)} key=${JSON.stringify(key)}`,
    )
  }
})

test('anything that is not a string is refused before any pattern runs', () => {
  // This is the case that matters most and the one a validator written for
  // strings gets wrong. A repeated query parameter arrives as an array, and a
  // regex test stringifies it: ['ic','C-2025-2026-Q1-00127'] becomes
  // "ic,C-2025-2026-Q1-00127", which is a valid key that no single parameter
  // ever carried. A missing value stringifies to the word "undefined", which
  // matches the supplier pattern and would be stored as a supplier for ever.
  const notStrings = [
    ['contract', ['ic', 'C-2025-2026-Q1-00127']],
    ['vendor', ['lumina', 'it']],
    ['vendor', undefined],
    ['vendor', null],
    ['contract', undefined],
    ['contract', null],
    ['vendor', 42],
    ['vendor', { toString: () => 'lumina it' }],
    [['contract'], 'ic,C-1'],
    [undefined, 'ic,C-1'],
    [null, 'ic,C-1'],
  ]
  for (const [kind, key] of notStrings) {
    assert.equal(
      parseWatchTarget(kind, key),
      null,
      `a non-string must be refused: kind=${JSON.stringify(kind)} key=${JSON.stringify(key)}`,
    )
  }

  // And the proof that this test could fail: the joined form of that array IS
  // an acceptable key, so only the type check refuses it.
  assert.deepEqual(parseWatchTarget('contract', ['ic', 'C-2025-2026-Q1-00127'].join(',')), {
    kind: 'contract',
    key: 'ic,C-2025-2026-Q1-00127',
  })
  assert.equal(String(undefined), 'undefined')
  assert.deepEqual(parseWatchTarget('vendor', String(undefined)), {
    kind: 'vendor',
    key: 'undefined',
  })
})

test('a contract key splits into the two halves the government record needs', () => {
  assert.deepEqual(splitContractKey('ic,C-2025-2026-Q1-00127'), {
    org: 'ic',
    reference: 'C-2025-2026-Q1-00127',
  })
})

test('the government record address is the one the public site uses', () => {
  // Written out in full rather than assembled from the same pieces the code
  // uses. The comma is the delimiter inside the path segment, so it is
  // percent-encoded and both halves are encoded with nothing left safe.
  assert.equal(
    governmentRecordUrl('ic,C-2025-2026-Q1-00127'),
    'https://search.open.canada.ca/contracts/record/ic%2CC-2025-2026-Q1-00127',
  )
  assert.equal(
    governmentRecordUrl(`esdc-edsc,C-2025${NB_HYPHEN}2026`),
    'https://search.open.canada.ca/contracts/record/esdc-edsc%2CC-2025%E2%80%912026',
  )
})

test('the counting sentence is right at nought, one and many, and leaves out an empty kind', () => {
  assert.equal(countNoun(1, 'contract'), '1 contract')
  assert.equal(countNoun(2, 'contract'), '2 contracts')
  assert.equal(countNoun(0, 'supplier'), '0 suppliers')
  assert.equal(watchingSentence(1, 0), 'You are watching 1 contract.')
  assert.equal(watchingSentence(2, 0), 'You are watching 2 contracts.')
  assert.equal(watchingSentence(0, 1), 'You are watching 1 supplier.')
  assert.equal(watchingSentence(5, 2), 'You are watching 5 contracts and 2 suppliers.')
  assert.equal(watchingSentence(1, 1), 'You are watching 1 contract and 1 supplier.')
})

test('the cap is the number the page says out loud', () => {
  assert.equal(MAX_WATCH_ITEMS, 200)
})
