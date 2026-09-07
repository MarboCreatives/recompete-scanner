// Turning a stored supplier key back into that supplier's page on the public
// site, and refusing to when the answer would be a guess.
//
// No network and no database. The fixture below is real markup, copied from
// https://recompeteradar.ca/incumbent/index.html on 7 September 2026, so these
// checks run in a CI job with no secrets and do not go dark when the site does.
//
// The expected answers are written out rather than derived from the code under
// test, which is CODING-STANDARDS 2.4. Every one of them was measured against
// the live site before it was written here:
//
//   * /incumbent/skyalyne.html and /incumbent/bgis-global-integrated-solutions.html
//     both return 404. Those are the addresses a re-derived slug produces, and
//     they are why this module exists at all. See GROUND-TRUTH G30.
//   * The pages that do exist are skyalyne-canada-limited-partnership.html and
//     bgis-global-integrated-solutions-ca.html, and both return 200.
//   * The site really does carry two Energere pages whose keys collide once
//     accents are folded. That is not a hypothetical.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTypeScriptResolver, libUrl } from './ts-resolve.mjs'

installTypeScriptResolver()
const { supplierLookupKey, parseIncumbentIndex } = await import(libUrl('supplier-directory.ts'))

// U+00C9 and U+00C8 written as escapes so this file cannot be broken by an
// editor or a checkout changing its encoding. The site prints them literally.
const ENERGERE_ACCENTED = 'ÉNERGÈRE INC.'

/**
 * Real markup, in the shape the site actually emits:
 *
 *     <li><a href="slug.html">Display Name</a> <span class="d">$14.3B · 8</span></li>
 *
 * The pagination link at the end is real too. The index links to its own
 * further pages, and those are lists rather than suppliers.
 */
const FIXTURE = [
  '<div class="c"><div class="v">1,761</div><div class="l">With detail pages</div></div></div><ul>',
  '<li><a href="bgis-global-integrated-solutions-ca.html">BGIS GLOBAL INTEGRATED SOLUTIONS CA</a> <span class="d">$14.3B</span></li>',
  '<li><a href="skyalyne-canada-limited-partnership.html">SkyAlyne Canada Limited Partnership</a> <span class="d">$11.2B</span></li>',
  '<li><a href="knds-deutschland-gmbh-co-kg.html">KNDS Deutschland GmbH &amp; Co. KG</a> <span class="d">$2.4B</span></li>',
  '<li><a href="pcl-constructors-canada-inc.html">PCL CONSTRUCTORS CANADA INC.</a> <span class="d">$3.1B</span></li>',
  `<li><a href="energere-inc.html">${ENERGERE_ACCENTED}</a> <span class="d">$58M</span></li>`,
  '<li><a href="energere-inc-energere.html">Energere Inc.</a> <span class="d">$58M</span></li>',
  '</ul><nav><a href="index-2.html">Next</a><a href="index-3.html">3</a></nav>',
].join('')

// --- the normalisation itself -----------------------------------------------

test('the lookup key is the ingest vendor_key, with accents folded', () => {
  const cases = [
    // [display name on the site, the key the app has stored]
    ['SkyAlyne Canada Limited Partnership', 'skyalyne', 'Canada, Limited and Partnership are all stopwords'],
    ['BGIS GLOBAL INTEGRATED SOLUTIONS CA', 'bgis global integrated solutions', 'CA is a stopword; the rest survives'],
    ['PCL CONSTRUCTORS CANADA INC.', 'pcl constructors', 'the trailing full stop is punctuation, not a word'],
    ['KNDS Deutschland GmbH & Co. KG', 'knds deutschland gmbh kg', 'Co is a stopword; the ampersand is punctuation'],
    [ENERGERE_ACCENTED, 'energere', 'accents are folded so both sides of a lookup compare'],
    ['Gami Ingeniería E Instalaciones', 'gami ingenieria e instalaciones', 'a real supplier with an accent mid-word'],
    ['  spaced   out  ltd  ', 'spaced out', 'runs of separators collapse, as split() does in Python'],
  ]
  for (const [display, expected, why] of cases) {
    assert.equal(supplierLookupKey(display), expected, `${display} -> ${expected} (${why})`)
  }
})

test('a key with no words left is empty rather than a stopword soup', () => {
  // "Canada Inc" is every token a stopword. It must not become a directory
  // entry, or every such supplier would collide on the empty string.
  assert.equal(supplierLookupKey('Canada Inc.'), '')
  assert.equal(supplierLookupKey('...'), '')
})

test('a script with no case of its own survives normalisation', () => {
  // The stored key keeps these characters, so the lookup must too. A naive
  // [a-z0-9] class would erase the whole name and match nothing.
  assert.equal(supplierLookupKey('中国 銀行'), '中国 銀行')
})

// --- reading the index ------------------------------------------------------

test('the two suppliers on the live watchlist resolve to their real pages', () => {
  const directory = parseIncumbentIndex(FIXTURE)
  assert.equal(directory.get('skyalyne'), 'skyalyne-canada-limited-partnership.html')
  assert.equal(
    directory.get('bgis global integrated solutions'),
    'bgis-global-integrated-solutions-ca.html',
  )
})

test('the address a guessed slug would produce is never what this returns', () => {
  // Both of these 404 on the live site. If either ever appears as a value here,
  // the module has started re-deriving a slug and the links are broken.
  const files = [...parseIncumbentIndex(FIXTURE).values()]
  assert.ok(!files.includes('skyalyne.html'))
  assert.ok(!files.includes('bgis-global-integrated-solutions.html'))
})

test('an HTML entity is decoded before the key is made', () => {
  // Undecoded, "GmbH &amp; Co. KG" normalises to a key containing the word
  // "amp", which matches no stored key, and this supplier silently loses its
  // link. This check is the whole reason decodeEntities exists.
  const directory = parseIncumbentIndex(FIXTURE)
  assert.equal(directory.get('knds deutschland gmbh kg'), 'knds-deutschland-gmbh-co-kg.html')
  assert.equal(directory.get('knds deutschland gmbh amp kg'), undefined)
})

test('two pages that fold to one key resolve to neither', () => {
  // Real: the site carries ENERGERE INC. with accents and Energere Inc. without,
  // as two separate pages. Sending a person to whichever came first would put
  // them on a page about a different legal entity.
  const directory = parseIncumbentIndex(FIXTURE)
  assert.equal(directory.get('energere'), undefined)
})

test('the index links to its own further pages, and those are not suppliers', () => {
  const files = [...parseIncumbentIndex(FIXTURE).values()]
  assert.ok(!files.some((f) => /^index(-\d+)?\.html$/.test(f)))
})

test('a supplier the site never published resolves to nothing', () => {
  // This is the suppression gate, and it works by inheritance rather than by
  // re-stating a rule. A private individual's vendor_key is blanked upstream by
  // suppress_individuals() before the site groups anything, so such a supplier
  // has no page and no index entry, and therefore no key here.
  //
  // MASTER-DESIGN rule 2 requires suppression at the display path. An outbound
  // link is the only supplier-facing thing the app renders that it did not get
  // from the person themselves, and this is what gates it.
  const directory = parseIncumbentIndex(FIXTURE)
  for (const personShaped of ['smith john', 'tremblay marie', 'wang wei', 'o brien']) {
    assert.equal(directory.get(personShaped), undefined, `${personShaped} must not resolve`)
  }
})

test('markup that is not the index at all yields nothing, not a partial answer', () => {
  // The caller applies a plausibility floor on top of this. Here the point is
  // narrower: no anchor of the expected shape means no entries, rather than an
  // exception that would take the watchlist down with it.
  assert.equal(parseIncumbentIndex('<html><body><p>Service Unavailable</p></body></html>').size, 0)
  assert.equal(parseIncumbentIndex('').size, 0)
  // An anchor with no text does not match the shape at all, so it never
  // reaches the empty-key guard below. Stated here so the next reader does not
  // mistake this for a test of that guard, which is what it was at first.
  assert.equal(parseIncumbentIndex('<li><a href="something.html"></a></li>').size, 0)
})

test('a name made only of stopwords is not stored under an empty key', () => {
  // No supplier on the index normalises to nothing today; that was measured,
  // not assumed. But "Canada Group Inc." is three stopwords and nothing else,
  // and it is an entirely ordinary company name. Without the guard two such
  // suppliers would collide on the empty string and be discarded as ambiguous,
  // and the empty key can never be looked up anyway: parseWatchTarget refuses
  // any stored key shorter than two characters.
  const directory = parseIncumbentIndex(
    FIXTURE + '<li><a href="canada-group-inc.html">Canada Group Inc.</a></li>',
  )
  assert.equal(directory.get(''), undefined)
  assert.ok(![...directory.values()].includes('canada-group-inc.html'))
})
