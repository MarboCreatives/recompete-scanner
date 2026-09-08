// Turning a stored supplier key back into that supplier's page on the public
// site, refusing to when the answer would be a guess, and saying which of
// "there is no page" and "I could not look" is true.
//
// No database and no server. The fixture below is real markup, copied from
// https://recompeteradar.ca/incumbent/index.html on 7 September 2026, and every
// expected key below was read off that supplier's own Watch link on the live
// site rather than derived here. That matters: an earlier version of this file
// scored the resolver against keys the resolver itself produced, which measured
// nothing. Since site pull request #15 shipped, each incumbent page carries the
// pipeline's own vendor_key, and that is the independent answer.
//
// Measured against 206 of those keys: 0 resolve to a wrong page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTypeScriptResolver, libUrl } from './ts-resolve.mjs'

installTypeScriptResolver()
const {
  supplierLookupKey,
  parseIncumbentIndex,
  resolveInDirectory,
  supplierPageUrls,
  resetSupplierDirectoryForTests,
} = await import(libUrl('supplier-directory.ts'))

// Written as escapes so this file cannot be broken by an editor or a checkout
// changing its encoding. The site prints them literally.
const E_ACUTE = 'É' // É
const E_GRAVE = 'È' // È
const e_acute = 'é' // é
const ELLIPSIS = '…'

const ENERGERE_ACCENTED = `${E_ACUTE}NERG${E_GRAVE}RE INC.`

/**
 * Real markup, in the shape the site emits:
 *
 *     <li><a href="slug.html">Display Name</a> <span class="d">$14.3B · 8</span></li>
 *
 * Every line here is copied from the live index, including the clipped names,
 * which end in U+2026 because build_site.py clips an index label at 52
 * characters.
 */
const FIXTURE = [
  '<div class="c"><div class="v">1,761</div><div class="l">With detail pages</div></div></div><ul>',
  '<li><a href="bgis-global-integrated-solutions-ca.html">BGIS GLOBAL INTEGRATED SOLUTIONS CA</a> <span class="d">$14.3B</span></li>',
  '<li><a href="skyalyne-canada-limited-partnership.html">SkyAlyne Canada Limited Partnership</a> <span class="d">$11.2B</span></li>',
  '<li><a href="knds-deutschland-gmbh-co-kg.html">KNDS Deutschland GmbH &amp; Co. KG</a> <span class="d">$2.4B</span></li>',
  '<li><a href="seguin-morris-inc.html">SEGUIN MORRIS INC.</a> <span class="d">$2M</span></li>',
  `<li><a href="energere-inc.html">${ENERGERE_ACCENTED}</a> <span class="d">$58M</span></li>`,
  '<li><a href="energere-inc-energere.html">Energere Inc.</a> <span class="d">$58M</span></li>',
  `<li><a href="wcg-international-consultants-ltd-lifemark-health-corp-in-joint-ventur.html">WCG INTERNATIONAL CONSULTANTS LTD.; LIFEMARK${ELLIPSIS}</a> <span class="d">$1B</span></li>`,
  `<li><a href="tato-recruiting-inc-and-s-i-systems-ulc-in-joint-venture.html">TATO RECRUITING INC. AND S.I. SYSTEMS ULC IN${ELLIPSIS}</a> <span class="d">$40M</span></li>`,
  `<li><a href="tato-recruiting-inc-and-s-i-systems-ulc-in-joint.html">Tato Recruiting Inc., and S.i. Systems ULC., in${ELLIPSIS}</a> <span class="d">$40M</span></li>`,
  '</ul><nav><a href="index-2.html">Next</a><a href="index-3.html">3</a></nav>',
].join('')

const resolve = (key, html = FIXTURE) => resolveInDirectory(parseIncumbentIndex(html), key)

// --- the normalisation itself -----------------------------------------------

test('the lookup key is the ingest vendor_key', () => {
  const cases = [
    ['SkyAlyne Canada Limited Partnership', 'skyalyne', 'Canada, Limited and Partnership are stopwords'],
    ['BGIS GLOBAL INTEGRATED SOLUTIONS CA', 'bgis global integrated solutions', 'CA is a stopword'],
    ['PCL CONSTRUCTORS CANADA INC.', 'pcl constructors', 'the trailing full stop is punctuation'],
    ['KNDS Deutschland GmbH & Co. KG', 'knds deutschland gmbh kg', 'Co is a stopword, & is punctuation'],
    ['  spaced   out  ltd  ', 'spaced out', 'runs of separators collapse, as split() does in Python'],
  ]
  for (const [display, expected, why] of cases) {
    assert.equal(supplierLookupKey(display), expected, `${display} -> ${expected} (${why})`)
  }
})

test('accents are kept, because the stored key keeps them too', () => {
  // An earlier version folded accents away. Measured, that was wrong twice
  // over: 0 of 1,761 display names are outside NFC, so it rescued nothing, and
  // it merged distinct suppliers. This is the regression check for that.
  assert.equal(supplierLookupKey(`S${e_acute}guin Morris Inc.`), `s${e_acute}guin morris`)
  assert.notEqual(
    supplierLookupKey(`S${e_acute}guin Morris Inc.`),
    supplierLookupKey('SEGUIN MORRIS INC.'),
  )
})

test('a key with no words left is empty rather than a stopword soup', () => {
  assert.equal(supplierLookupKey('Canada Inc.'), '')
  assert.equal(supplierLookupKey('...'), '')
})

test('a script with no case of its own survives normalisation', () => {
  assert.equal(supplierLookupKey('中国 銀行'), '中国 銀行')
})

// --- resolving --------------------------------------------------------------

test('the suppliers on the live watchlist resolve to their real pages', () => {
  assert.equal(resolve('skyalyne'), 'skyalyne-canada-limited-partnership.html')
  assert.equal(
    resolve('bgis global integrated solutions'),
    'bgis-global-integrated-solutions-ca.html',
  )
})

test('the address a guessed slug would produce is never returned', () => {
  // Both 404 on the live site. If either appears, the module has started
  // re-deriving a slug, which build_site.py warns against by name.
  const { byKey, byPrefix } = parseIncumbentIndex(FIXTURE)
  const files = [...byKey.values(), ...byPrefix.values()]
  assert.ok(!files.includes('skyalyne.html'))
  assert.ok(!files.includes('bgis-global-integrated-solutions.html'))
})

test('an accented supplier never lands on its unaccented namesake', () => {
  // The measured failure that removed accent folding. seguin-morris-inc.html
  // belongs to "seguin morris": six contracts, $2M. The watched group
  // "séguin morris" is a different supplier with one contract and $17K.
  assert.equal(resolve('seguin morris'), 'seguin-morris-inc.html')
  assert.equal(resolve(`s${e_acute}guin morris`), null)
})

test('two suppliers spelled alike but for an accent each get their own page', () => {
  assert.equal(resolve('energere'), 'energere-inc-energere.html')
  assert.equal(resolve(`${e_acute}nerg${'è'}re`), 'energere-inc.html')
})

test('an HTML entity is decoded before the key is made', () => {
  // Undecoded, "GmbH &amp; Co. KG" yields a key containing "amp", which matches
  // no stored key, and this supplier silently loses its link.
  assert.equal(resolve('knds deutschland gmbh kg'), 'knds-deutschland-gmbh-co-kg.html')
  assert.equal(resolve('knds deutschland gmbh amp kg'), null)
})

test('two pages with the same whole name resolve to neither', () => {
  const html =
    '<li><a href="acme-systems-inc.html">Acme Systems Inc.</a></li>' +
    '<li><a href="acme-systems-ltd.html">ACME SYSTEMS LTD.</a></li>'
  assert.equal(resolve('acme systems', html), null)
})

test('the index links to its own further pages, and those are not suppliers', () => {
  const { byKey, byPrefix } = parseIncumbentIndex(FIXTURE)
  const files = [...byKey.values(), ...byPrefix.values()]
  assert.ok(!files.some((f) => /^index(-\d+)?\.html$/.test(f)))
})

// --- names the site clipped -------------------------------------------------

test('a stored key that extends one clipped name resolves to it', () => {
  // The index shows "WCG INTERNATIONAL CONSULTANTS LTD.; LIFEMARK…" because
  // build_site.py clips at 52 characters. The stored key, read off that page's
  // own Watch link, is the whole thing. Without this, 35 of the 37 clipped
  // suppliers resolve to nothing while their page returns 200 — and the row
  // then tells the person no page exists, which is false.
  assert.equal(
    resolve('wcg international consultants lifemark health in joint venture'),
    'wcg-international-consultants-ltd-lifemark-health-corp-in-joint-ventur.html',
  )
})

test('a clipped name that two suppliers could extend resolves to neither', () => {
  // Both Tato joint-venture pages clip to the same prefix. Their stored keys
  // differ only after it, so either would be a guess.
  assert.equal(resolve('tato recruiting s i systems ulc in joint venture'), null)
  assert.equal(resolve('tato recruiting s i systems ulc in joint'), null)
})

test('a prefix only matches on a word boundary', () => {
  const html = `<li><a href="acme.html">Acme Consulting Group Interna${ELLIPSIS}</a></li>`
  // "acme consulting" is the prefix. A key that merely starts with those
  // letters, rather than those words, must not match.
  assert.equal(resolve('acme consulting international', html), 'acme.html')
  assert.equal(resolve('acme consultingx international', html), null)
})

// --- markup that is not the index ------------------------------------------

test('markup that is not the index yields nothing, not a partial answer', () => {
  const empty = (html) => {
    const d = parseIncumbentIndex(html)
    return d.byKey.size + d.byPrefix.size
  }
  assert.equal(empty('<html><body><p>Service Unavailable</p></body></html>'), 0)
  assert.equal(empty(''), 0)
  // An anchor with no text does not match the shape at all, so it never reaches
  // the empty-key guard. Stated so the next reader does not mistake this for a
  // test of that guard, which is what it was at first.
  assert.equal(empty('<li><a href="something.html"></a></li>'), 0)
})

test('a name made only of stopwords is not stored under an empty key', () => {
  // No supplier on the index normalises to nothing today; that was measured.
  // But "Canada Group Inc." is three stopwords and an ordinary company name.
  const d = parseIncumbentIndex(
    FIXTURE + '<li><a href="canada-group-inc.html">Canada Group Inc.</a></li>',
  )
  assert.equal(d.byKey.get(''), undefined)
  assert.ok(![...d.byKey.values()].includes('canada-group-inc.html'))
})

// --- what happens when the site cannot be read ------------------------------

function withFetch(stub, run) {
  const real = globalThis.fetch
  globalThis.fetch = stub
  resetSupplierDirectoryForTests()
  return run().finally(() => {
    globalThis.fetch = real
    resetSupplierDirectoryForTests()
  })
}

const okResponse = (body) => ({ ok: true, status: 200, text: async () => body })

test('a working site resolves and reports ok', async () => {
  await withFetch(async () => okResponse(BIG_ENOUGH), async () => {
    const r = await supplierPageUrls(['skyalyne'])
    assert.equal(r.status, 'ok')
    assert.equal(
      r.urls.get('skyalyne'),
      'https://recompeteradar.ca/incumbent/skyalyne-canada-limited-partnership.html',
    )
  })
})

test('a site that will not answer reports unavailable, not "no page"', async () => {
  // The distinction the watchlist prints. An empty map and a failed fetch would
  // otherwise be the same value, and the page would assert up to 200 times that
  // pages do not exist when the truth is that nobody looked.
  await withFetch(async () => { throw new Error('ECONNREFUSED') }, async () => {
    const r = await supplierPageUrls(['skyalyne'])
    assert.equal(r.status, 'unavailable')
    assert.equal(r.urls.size, 0)
  })
  await withFetch(async () => ({ ok: false, status: 503, text: async () => '' }), async () => {
    assert.equal((await supplierPageUrls(['skyalyne'])).status, 'unavailable')
  })
})

test('markup below the plausibility floor is unavailable, not a short directory', async () => {
  await withFetch(async () => okResponse(FIXTURE), async () => {
    // The fixture has ten entries, far below the floor of 500.
    const r = await supplierPageUrls(['skyalyne'])
    assert.equal(r.status, 'unavailable')
  })
})

test('a later failure does not erase a directory that already loaded', async () => {
  // The cache must be aged, or nothing refetches and this passes without ever
  // reaching the code it names. That is what the first version of this check
  // did, and the break harness found it: clobbering the good directory on
  // failure went undetected.
  let fail = false
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    if (fail) throw new Error('ECONNREFUSED')
    return okResponse(BIG_ENOUGH)
  }
  resetSupplierDirectoryForTests()
  try {
    assert.equal((await supplierPageUrls(['skyalyne'])).status, 'ok')

    fail = true
    resetSupplierDirectoryForTests({ expire: true })
    // Serves the stale copy and starts a refresh that will fail.
    assert.equal((await supplierPageUrls(['skyalyne'])).status, 'ok')
    await new Promise((resolve) => setTimeout(resolve, 25))

    const after = await supplierPageUrls(['skyalyne'])
    assert.equal(after.status, 'ok', 'the last good directory must survive a failed refresh')
    assert.ok(after.urls.has('skyalyne'))
  } finally {
    globalThis.fetch = real
    resetSupplierDirectoryForTests()
  }
})

test('an empty watchlist asks the site nothing at all', async () => {
  let calls = 0
  await withFetch(async () => { calls++; return okResponse(BIG_ENOUGH) }, async () => {
    const r = await supplierPageUrls([])
    assert.equal(r.status, 'ok')
    assert.equal(calls, 0, 'no supplier watched means no request')
  })
})

test('many suppliers on one page cost one request, not one each', async () => {
  let calls = 0
  await withFetch(async () => { calls++; return okResponse(BIG_ENOUGH) }, async () => {
    await supplierPageUrls(['skyalyne', 'energere', 'knds deutschland gmbh kg'])
    await supplierPageUrls(['skyalyne'])
    assert.equal(calls, 1)
  })
})

// Padding the real fixture past the plausibility floor with distinct, ordinary
// entries, so the failure-policy checks above exercise a directory the module
// is willing to believe.
const PADDING = Array.from(
  { length: 600 },
  (_, i) => `<li><a href="filler-${i}.html">Filler Number ${i} Systems</a></li>`,
).join('')
const BIG_ENOUGH = FIXTURE + PADDING
