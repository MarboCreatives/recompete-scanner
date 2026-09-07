// Turning a watched supplier key back into the supplier's page on
// recompeteradar.ca.
//
// ## The problem, measured rather than assumed
//
// The app stores a supplier as the ingest's `vendor_key`: the published name
// lowercased, punctuation replaced by spaces, and legal-form and geography
// words removed. `skyalyne`. `bgis global integrated solutions`.
//
// recompeteradar.ca names an incumbent page after the **display** name, not
// after that key. The two are not the same string and the normalisation only
// runs one way, so a URL cannot be guessed. Measured on 7 September 2026:
//
//     /incumbent/skyalyne.html                          404
//     /incumbent/bgis-global-integrated-solutions.html  404
//
// The real pages are `skyalyne-canada-limited-partnership.html` and
// `bgis-global-integrated-solutions-ca.html`. `build_site.py` says so itself,
// at its FILENAMES declaration: "Links are built from this map, never by
// re-deriving the slug from a display name — collision-renamed pages would be
// silently orphaned." This file does not re-derive a slug. See GROUND-TRUTH
// G30.
//
// ## Why the index page and not the sitemap
//
// The obvious source is `sitemap.xml`, which lists every incumbent page. Taking
// the filename apart and normalising it was tried first and measured against
// the site's own display names: it agrees with the stored key **94.6%** of the
// time, or 95.9% with accents folded. It fails on two things it cannot help.
// Accented names are transliterated in a filename and are not in a key, and
// `slug()` truncates at 70 characters, so a long name produces a filename that
// can never be normalised back to the whole key.
//
// `/incumbent/index.html` carries the display name itself, next to the href.
// Deriving the key from that display name is the same operation the ingest
// performed to make the stored key in the first place, so the two agree by
// construction rather than by luck. Measured on the live page, same day:
//
//     distinct supplier keys on the index   1,759
//     resolve to exactly one page           1,750  (99.5%)
//     ambiguous, and so given no link           9
//
// The nine are genuine duplicate pages on the site, such as `energere-inc` and
// `energere-inc-energere`. Guessing between them would put a person on a page
// about a different legal entity, so they get nothing.
//
// ## What this does not do
//
// It does not invent a display name. The page shows the stored key, which is
// what the person watched and what SUPPLIER_KEY_NOTE already explains. The
// index gives capitalisation but not reliably the full legal name, and a name
// this product made up is worse than a normalised one it can account for.
//
// ## Suppression is inherited, not re-implemented
//
// A private individual's `vendor_key` is blanked by `suppress_individuals()`
// before the site groups anything, so such a supplier has **no page, no index
// entry and therefore no key in this directory**. A person-shaped key resolves
// to nothing here and is given no link, without this file knowing anything
// about names or people. That is the same dependency the site's own Watch
// links take, once, upstream, and it is the reason this is a lookup against
// what the site published rather than a rule re-stated in a second place.
//
// MASTER-DESIGN rule 2 requires suppression at the display path. This is that
// gate for the only supplier-facing thing the app currently renders that it did
// not receive from the person themselves: an outbound link.

import { optionalEnv } from './env'
import { log } from './log'

/** Where the public site lives. Public, and not a secret. */
const DEFAULT_SITE_URL = 'https://recompeteradar.ca'

/** The one page that carries every incumbent's name beside its address. */
const INDEX_PATH = '/incumbent/index.html'

/**
 * How long a good directory is kept.
 *
 * The site rebuilds monthly on a schedule and on merge, so six hours is far
 * more often than the data can change. It exists to bound staleness, not to
 * chase it.
 */
const GOOD_TTL_MS = 6 * 60 * 60 * 1000

/**
 * How long a failure is kept.
 *
 * Short, because a failure is usually a blip and the cost of retrying is one
 * request. Not zero, because a site that is properly down should not be asked
 * again on every render of every watchlist.
 */
const FAILURE_TTL_MS = 60 * 1000

/**
 * A fetch that never returns must not hold a page open.
 *
 * AUDIT-2026-09-06 records that the Resend call has no timeout. Not repeating
 * that here: the watchlist must render whether or not the public site answers,
 * and four seconds is already far longer than the page it is fetching takes.
 */
const FETCH_TIMEOUT_MS = 4000

/**
 * The fewest entries a believable index has.
 *
 * The live page carried 1,759 distinct keys on 7 September 2026. If a parse
 * returns fewer than this the markup has changed shape and the result is not
 * trustworthy, so it is discarded rather than half-used. Without this floor a
 * site redesign would silently drop most links while leaving a few, which reads
 * as data being missing rather than as something being broken.
 */
const PLAUSIBILITY_FLOOR = 500

/**
 * The ingest's own stopword list, from `ingest.py` VENDOR_STOPWORDS.
 *
 * Copied deliberately rather than derived. This must equal what produced the
 * stored key; a clever re-derivation that drifted would break every lookup at
 * once and look like the site being down.
 */
const VENDOR_STOPWORDS = new Set([
  'and',
  'ca',
  'canada',
  'co',
  'company',
  'corp',
  'corporation',
  'group',
  'holdings',
  'inc',
  'limited',
  'llp',
  'lp',
  'ltd',
  'ltee',
  'of',
  'partnership',
  'the',
])

/**
 * The five named entities the site's escaping can produce, plus numeric ones.
 *
 * This matters more than it looks. `A &amp; B` left undecoded normalises to
 * `a amp b`, which matches no stored key, so a supplier with an ampersand in
 * its name would silently lose its link.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? whole : named
  })
}

/**
 * The ingest's `vendor_key`, then accents folded away.
 *
 * The first half is a port of `ingest.py`:
 *
 *     cleaned = "".join(ch if ch.isalnum() else " " for ch in name.lower())
 *     return " ".join(w for w in cleaned.split() if w not in VENDOR_STOPWORDS)
 *
 * `\p{L}\p{N}` rather than `[a-z0-9]` because Python's `str.isalnum` is
 * Unicode-aware, and a supplier registered in French, Spanish or Greek would
 * otherwise normalise to a different string here than it did at ingest.
 *
 * The second half folds accents, and applies to **both** sides of the lookup so
 * they remain comparable. It exists because a stored key keeps its accents and
 * some of the site's own display text does not survive a round trip unchanged.
 * Folding can in principle merge two suppliers whose names differ only by an
 * accent; that is why an ambiguous key is dropped rather than resolved.
 */
export function supplierLookupKey(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  const kept = cleaned.split(' ').filter((w) => w !== '' && !VENDOR_STOPWORDS.has(w))
  return kept
    .join(' ')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
}

/**
 * Read `(key -> page filename)` out of the incumbent index page.
 *
 * Pure and exported so a check can drive it with real markup and with markup
 * that has been broken on purpose. A key seen more than once is removed
 * entirely rather than resolved to whichever page came first.
 */
export function parseIncumbentIndex(html: string): Map<string, string> {
  const seen = new Map<string, string>()
  const ambiguous = new Set<string>()

  // The index links to its own further pages as index-2.html and so on. Those
  // are lists, not suppliers, and must not become directory entries.
  const LINK = /href="([a-z0-9][a-z0-9-]*\.html)"[^>]*>([^<]+)</g

  for (const match of html.matchAll(LINK)) {
    const file = match[1]
    if (file === 'index.html' || /^index-\d+\.html$/.test(file)) continue

    const key = supplierLookupKey(decodeEntities(match[2]))
    if (key === '') continue

    const already = seen.get(key)
    if (already !== undefined && already !== file) {
      ambiguous.add(key)
      continue
    }
    seen.set(key, file)
  }

  for (const key of ambiguous) seen.delete(key)
  return seen
}

/** The public site's address. */
export function siteUrl(): string {
  return (optionalEnv('SITE_URL') ?? DEFAULT_SITE_URL).replace(/\/+$/, '')
}

type CacheEntry = { at: number; ttl: number; directory: Map<string, string> }

// Module scope, so one server instance fetches the index at most once per TTL
// rather than once per rendered watchlist. A cold instance fetches again, which
// is the correct trade: no shared store to operate, and the cost is one request
// for a page the site serves statically.
let cache: CacheEntry | undefined
let inFlight: Promise<Map<string, string>> | undefined

/** Only for checks: forget everything, so a case starts from a known state. */
export function resetSupplierDirectoryForTests(): void {
  cache = undefined
  inFlight = undefined
}

async function fetchDirectory(): Promise<Map<string, string>> {
  const started = Date.now()
  try {
    const response = await fetch(`${siteUrl()}${INDEX_PATH}`, {
      // No credentials, no cookies, and nothing about the person is sent. This
      // asks a public page a question that does not mention them.
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/html' },
    })
    if (!response.ok) {
      log({ event: 'supplier_directory_unavailable', status: response.status, ms: Date.now() - started })
      return new Map()
    }
    const directory = parseIncumbentIndex(await response.text())
    if (directory.size < PLAUSIBILITY_FLOOR) {
      log({
        event: 'supplier_directory_implausible',
        count: directory.size,
        ms: Date.now() - started,
        reason: 'fewer entries than the floor; markup has probably changed',
      })
      return new Map()
    }
    log({ event: 'supplier_directory_loaded', count: directory.size, ms: Date.now() - started })
    return directory
  } catch {
    // Deliberately no error detail. Whatever went wrong, the fix is on the
    // other side of a network call, and an exception object here has never
    // been near a watchlist but is not worth the risk of proving that again.
    log({ event: 'supplier_directory_failed', ms: Date.now() - started })
    return new Map()
  }
}

async function directory(): Promise<Map<string, string>> {
  const now = Date.now()
  if (cache !== undefined && now - cache.at < cache.ttl) return cache.directory
  if (inFlight !== undefined) return inFlight

  inFlight = fetchDirectory()
    .then((loaded) => {
      cache = {
        at: Date.now(),
        ttl: loaded.size === 0 ? FAILURE_TTL_MS : GOOD_TTL_MS,
        directory: loaded,
      }
      return loaded
    })
    .finally(() => {
      inFlight = undefined
    })

  return inFlight
}

/**
 * The supplier's own page on recompeteradar.ca, or null.
 *
 * Null is an ordinary answer, not a fault. Most suppliers in the contract data
 * are below the site's thin-content threshold and have no page at all, and a
 * private individual has none by design. The caller must say so in words rather
 * than render a control that goes nowhere.
 *
 * Never throws. A watchlist that failed to render because a different site was
 * slow would be a worse product than one without links.
 */
export async function supplierPageUrl(vendorKey: string): Promise<string | null> {
  if (typeof vendorKey !== 'string' || vendorKey === '') return null
  const file = (await directory()).get(supplierLookupKey(vendorKey))
  return file === undefined ? null : `${siteUrl()}/incumbent/${file}`
}

/** Resolve many at once, so one watchlist render awaits the directory once. */
export async function supplierPageUrls(vendorKeys: string[]): Promise<Map<string, string>> {
  const loaded = await directory()
  const out = new Map<string, string>()
  for (const key of vendorKeys) {
    const file = loaded.get(supplierLookupKey(key))
    if (file !== undefined) out.set(key, `${siteUrl()}/incumbent/${file}`)
  }
  return out
}

/**
 * What a person is told when a supplier has no page.
 *
 * "No page" with no explanation reads as the product having lost something, so
 * something has to be said. But it deliberately does not say **why**, because
 * this module does not know and must not appear to.
 *
 * There are two reasons a supplier is absent from the directory. Most are below
 * the site's size threshold. Some are private individuals, whose key is blanked
 * upstream before the site groups anything. Naming the size threshold as the
 * reason would be a guess, and for the second group it would be a wrong guess
 * printed next to a person's name. Naming the other reason would be worse: it
 * would turn an absence into a statement about someone, which is the whole
 * thing MASTER-DESIGN rule 2 exists to prevent.
 *
 * So it states the fact and stops.
 */
export const NO_SUPPLIER_PAGE_NOTE =
  'This supplier has no page on recompeteradar.ca, so there is nothing to link to. The site does not publish a page for every supplier.'
