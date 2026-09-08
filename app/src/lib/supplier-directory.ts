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
// Taking a filename apart and normalising it was tried first. It agrees with
// the stored key 94.6% of the time and cannot do better: a filename has its
// accents transliterated and `slug()` truncates it at 70 characters.
//
// `/incumbent/index.html` carries the display name itself, next to the href.
// Deriving the key from that display name is the same operation the ingest
// performed to make the stored key, so the two agree by construction.
//
// ## How this is scored, and why the obvious score was wrong
//
// The first measurement counted how many index-derived keys were unique among
// themselves. That number said nothing, because both sides of it came from the
// same derivation. Since site pull request #15 shipped, **every incumbent page
// carries its own Watch link with the real `vendor_key` in it**, produced by
// the pipeline and not by anything here. That is the independent answer, and it
// is what this is scored against now. See GROUND-TRUTH G30.
//
// ## Suppression is inherited, not re-implemented
//
// A private individual's `vendor_key` is blanked by `suppress_individuals()`
// before the site groups anything, so such a supplier has **no page, no index
// entry and therefore no key in this directory**. A person-shaped key resolves
// to nothing and is given no link, without this file knowing anything about
// names or people. That is the same dependency the site's own Watch links take,
// once, upstream.
//
// MASTER-DESIGN rule 2 requires suppression at the display path. This is that
// gate for the only supplier-facing thing the app renders that it did not
// receive from the person themselves: an outbound link.

import { optionalEnv } from './env'
import { log } from './log'

/** Where the public site lives. Public, and not a secret. */
const DEFAULT_SITE_URL = 'https://recompeteradar.ca'

/** The one page that carries every incumbent's name beside its address. */
const INDEX_PATH = '/incumbent/index.html'

/**
 * How long a good directory is kept before a refresh is started.
 *
 * The site rebuilds monthly on a schedule and on merge, so six hours is far
 * more often than the data can change. It bounds staleness; it does not chase.
 */
const GOOD_TTL_MS = 6 * 60 * 60 * 1000

/** How long to wait before trying again after a failure. */
const FAILURE_TTL_MS = 60 * 1000

/**
 * A fetch that never returns must not hold a page open.
 *
 * AUDIT-2026-09-06 records that the Resend call has no timeout. Not repeating
 * that here: the watchlist must render whether or not the public site answers.
 */
const FETCH_TIMEOUT_MS = 4000

/**
 * The fewest entries a believable index has.
 *
 * The live page carried 1,761 anchors on 7 September 2026. Below this the
 * markup has changed shape and the result is not trustworthy, so it is
 * discarded rather than half-used and the caller is told the source was
 * unavailable. A partial parse that silently dropped most links would read as
 * data being missing rather than as something being broken.
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
 * The character `clip()` appends when it shortens a display name.
 *
 * `build_site.py` clips an index label to 52 characters. 37 of the 1,761
 * anchors carry this, and their derived key is only a prefix of the real one.
 * See `TRUNCATED` handling below.
 */
const ELLIPSIS = '…'

/** The named entities the site's escaping can produce, plus numeric ones. */
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
 * The ingest's `vendor_key`. A port of `ingest.py`:
 *
 *     cleaned = "".join(ch if ch.isalnum() else " " for ch in name.lower())
 *     return " ".join(w for w in cleaned.split() if w not in VENDOR_STOPWORDS)
 *
 * `\p{L}\p{N}` rather than `[a-z0-9]` because Python's `str.isalnum` is
 * Unicode-aware, and a supplier registered in French, Spanish or Greek would
 * otherwise normalise here to something it did not normalise to at ingest.
 *
 * **Accents are kept.** An earlier version folded them away, on the theory that
 * the site's text might not survive a round trip. That was measured and it is
 * false: 0 of 1,761 display names are outside NFC, and the stored key keeps its
 * accents too, so both sides already matched. Folding was not merely useless.
 * It merged distinct suppliers: `séguin morris` resolved to
 * `seguin-morris-inc.html`, which is a different group with six contracts and
 * $2M against the watched group's one contract and $17K, and it dropped
 * `université laval`, `énergère` and `atkinsréalis` entirely by colliding them
 * with unaccented namesakes. NFC is applied instead, which makes two spellings
 * of the same accent compare equal without making two different names equal.
 */
export function supplierLookupKey(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  if (cleaned === '') return ''
  return cleaned
    .split(' ')
    .filter((w) => w !== '' && !VENDOR_STOPWORDS.has(w))
    .join(' ')
}

/**
 * `byKey` is the whole name. `byPrefix` is for the anchors the site clipped:
 * the key of everything before the clipped word, which a stored key can extend.
 * A prefix seen more than once is dropped, exactly as a whole key is.
 */
export type SupplierDirectory = {
  byKey: Map<string, string>
  byPrefix: Map<string, string>
}

/**
 * Read a directory out of the incumbent index page.
 *
 * Pure and exported so a check can drive it with real markup and with markup
 * broken on purpose. A key seen on two different pages is removed entirely
 * rather than resolved to whichever came first.
 */
export function parseIncumbentIndex(html: string): SupplierDirectory {
  const byKey = new Map<string, string>()
  const byPrefix = new Map<string, string>()
  const ambiguousKeys = new Set<string>()
  const ambiguousPrefixes = new Set<string>()

  // The index links to its own further pages as index-2.html and so on. Those
  // are lists, not suppliers, and must not become directory entries.
  const LINK = /href="([a-z0-9][a-z0-9-]*\.html)"[^>]*>([^<]+)</g

  for (const match of html.matchAll(LINK)) {
    const file = match[1]
    if (file === 'index.html' || /^index-\d+\.html$/.test(file)) continue

    const display = decodeEntities(match[2])

    if (display.includes(ELLIPSIS)) {
      // The name was clipped, so the last word may be a fragment. Drop it and
      // keep what is certainly whole, as a prefix a full key can extend.
      const words = supplierLookupKey(display.replace(ELLIPSIS, ' ')).split(' ')
      words.pop()
      const prefix = words.join(' ')
      if (prefix === '') continue
      const already = byPrefix.get(prefix)
      if (already !== undefined && already !== file) ambiguousPrefixes.add(prefix)
      else byPrefix.set(prefix, file)
      continue
    }

    const key = supplierLookupKey(display)
    if (key === '') continue
    const already = byKey.get(key)
    if (already !== undefined && already !== file) ambiguousKeys.add(key)
    else byKey.set(key, file)
  }

  for (const key of ambiguousKeys) byKey.delete(key)
  for (const prefix of ambiguousPrefixes) byPrefix.delete(prefix)
  return { byKey, byPrefix }
}

/**
 * The page for one stored key, or null.
 *
 * An exact match first. Failing that, a stored key that extends exactly one
 * clipped prefix, on a word boundary so `abc` cannot match `abcdef`. Measured
 * against the keys the site itself publishes: prefix recovery returns 31 of the
 * 35 clipped names to the right page and none to a wrong one, and the four it
 * cannot separate get nothing.
 */
export function resolveInDirectory(
  directory: SupplierDirectory,
  storedKey: string,
): string | null {
  const key = supplierLookupKey(storedKey)
  if (key === '') return null

  const exact = directory.byKey.get(key)
  if (exact !== undefined) return exact

  let found: string | null = null
  for (const [prefix, file] of directory.byPrefix) {
    if (key === prefix || key.startsWith(`${prefix} `)) {
      if (found !== null && found !== file) return null
      found = file
    }
  }
  return found
}

/** The public site's address. */
export function siteUrl(): string {
  return (optionalEnv('SITE_URL') ?? DEFAULT_SITE_URL).replace(/\/+$/, '')
}

const EMPTY: SupplierDirectory = { byKey: new Map(), byPrefix: new Map() }

type CacheEntry = { at: number; ttl: number; directory: SupplierDirectory | null }

// Module scope, so one server instance fetches the index at most once per TTL
// rather than once per rendered watchlist.
let cache: CacheEntry | undefined
let inFlight: Promise<SupplierDirectory | null> | undefined

/**
 * Only for checks.
 *
 * With no argument, forget everything so a case starts from a known state.
 * With `{ expire: true }`, keep the loaded directory but mark it old, so the
 * next call refreshes. Without that, a check cannot reach the refresh path at
 * all: the good TTL is six hours, so a second call inside one test run is
 * always served from memory. The first version of the "a failure must not
 * erase a good directory" check passed for exactly that reason while the
 * behaviour it named was broken, and the break harness caught it.
 */
export function resetSupplierDirectoryForTests(options?: { expire?: boolean }): void {
  if (options?.expire === true && cache !== undefined) {
    cache = { ...cache, at: 0 }
    inFlight = undefined
    return
  }
  cache = undefined
  inFlight = undefined
}

/** Null means the source could not be read. An empty directory does not exist. */
async function fetchDirectory(): Promise<SupplierDirectory | null> {
  const started = Date.now()
  try {
    const response = await fetch(`${siteUrl()}${INDEX_PATH}`, {
      // No credentials and no cookies. This asks a public page a question that
      // does not mention the person the page is being rendered for.
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/html' },
    })
    if (!response.ok) {
      log({ event: 'supplier_directory_unavailable', status: response.status, ms: Date.now() - started })
      return null
    }
    const directory = parseIncumbentIndex(await response.text())
    const size = directory.byKey.size + directory.byPrefix.size
    if (size < PLAUSIBILITY_FLOOR) {
      log({
        event: 'supplier_directory_implausible',
        count: size,
        ms: Date.now() - started,
        reason: 'fewer entries than the floor; markup has probably changed',
      })
      return null
    }
    log({ event: 'supplier_directory_loaded', count: size, ms: Date.now() - started })
    return directory
  } catch {
    // Deliberately no error detail. Whatever went wrong is on the other side of
    // a network call, and an exception object is not worth the risk of proving
    // again that it has never been near a watchlist.
    log({ event: 'supplier_directory_failed', ms: Date.now() - started })
    return null
  }
}

/**
 * The directory, or null when the source could not be read.
 *
 * A failure never discards a directory that was already loaded: the last good
 * copy keeps being served and only the retry clock is reset. A stale copy is
 * also served while a refresh runs, so a slow site cannot add four seconds to a
 * render that could have been answered from memory.
 */
async function loadDirectory(): Promise<SupplierDirectory | null> {
  const now = Date.now()
  const known = cache?.directory ?? null

  if (cache !== undefined && now - cache.at < cache.ttl) return known
  if (inFlight !== undefined) return known ?? inFlight

  inFlight = fetchDirectory()
    .then((loaded) => {
      cache = {
        at: Date.now(),
        ttl: loaded === null ? FAILURE_TTL_MS : GOOD_TTL_MS,
        // A blip must not erase a good answer.
        directory: loaded ?? cache?.directory ?? null,
      }
      return cache.directory
    })
    .finally(() => {
      inFlight = undefined
    })

  return known ?? inFlight
}

/**
 * Why a supplier has no link.
 *
 * `ok` means the site was read and the answer is that there is no page.
 * `unavailable` means the site could not be read and nothing can be said, which
 * CODING-STANDARDS 4 requires be shown as itself rather than as an empty state.
 */
export type SupplierPages = {
  status: 'ok' | 'unavailable'
  urls: Map<string, string>
}

/** Resolve many at once, so one watchlist render reads the directory once. */
export async function supplierPageUrls(vendorKeys: string[]): Promise<SupplierPages> {
  if (vendorKeys.length === 0) return { status: 'ok', urls: new Map() }

  const loaded = await loadDirectory()
  if (loaded === null) return { status: 'unavailable', urls: new Map() }

  const urls = new Map<string, string>()
  for (const key of vendorKeys) {
    const file = resolveInDirectory(loaded, key)
    if (file !== null) urls.set(key, `${siteUrl()}/incumbent/${file}`)
  }
  return { status: 'ok', urls }
}

/** One supplier. Never throws; null is an ordinary answer. */
export async function supplierPageUrl(vendorKey: string): Promise<string | null> {
  if (typeof vendorKey !== 'string' || vendorKey === '') return null
  const loaded = await loadDirectory()
  if (loaded === null) return null
  const file = resolveInDirectory(loaded, vendorKey)
  return file === null ? null : `${siteUrl()}/incumbent/${file}`
}

export { EMPTY as EMPTY_SUPPLIER_DIRECTORY }

/**
 * What a person is told when a supplier has no page.
 *
 * "No page" with no explanation reads as the product having lost something, so
 * something has to be said. But it deliberately does not say **why**, because
 * this module does not know and must not appear to.
 *
 * There are two reasons a supplier is absent. Most are below the site's size
 * threshold. Some are private individuals, whose key is blanked upstream before
 * the site groups anything. Naming the size threshold would be a guess, and for
 * the second group a wrong guess printed next to a person's name. Naming the
 * other reason would be worse: it would turn an absence into a statement about
 * someone, which is what MASTER-DESIGN rule 2 exists to prevent.
 */
export const NO_SUPPLIER_PAGE_NOTE =
  'This supplier has no page on recompeteradar.ca, so there is nothing to link to. The site does not publish a page for every supplier.'

/**
 * What a person is told when the site could not be read.
 *
 * Shown once above the list rather than on every row, and it must never be
 * confused with NO_SUPPLIER_PAGE_NOTE. That sentence is a claim about the
 * world; this one is a claim about this request. A watchlist may hold 200
 * suppliers, so printing the wrong one of these would assert 200 times that
 * pages do not exist when the truth is that nobody looked.
 */
export const SUPPLIER_LINKS_UNAVAILABLE_NOTE =
  'Links to recompeteradar.ca are not available just now, so none are shown below. Your watchlist is unaffected.'
