// The frame every page sits in, and the two stylesheet rules that made the app
// unreadable.
//
// These exist because the owner opened the site on a phone and said the design
// looked terrible, and he was right in two specific ways that no check could
// see. Both came from the framework scaffold:
//
//   * `a { color: inherit; text-decoration: none }` made every link identical
//     to the text beside it. Every piece of navigation here is a link,
//     including the only way in from the landing page.
//   * `* { padding: 0; margin: 0 }` with nothing putting the margins back, and
//     no padding on the body, so paragraphs ran together and every line touched
//     the edge of the screen.
//
// Why nothing caught them: every page assertion runs through visibleText(),
// which strips markup and collapses whitespace before matching, so a page laid
// out well and a page with no layout at all produce identical strings. Nothing
// in this repository loads the stylesheet or renders anything.
//
// These checks cannot see a rendered page either. What they hold is the rule:
// the stylesheet must not contain the two things that caused it, and the frame
// must carry a way out of every page. Seeing it takes a browser at 375px, and
// nothing here does that yet.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { visibleText } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const css = readFileSync(join(here, '..', 'src', 'app', 'globals.css'), 'utf8')
const layout = readFileSync(join(here, '..', 'src', 'app', 'layout.tsx'), 'utf8')

/** The stylesheet with comments removed, so prose about a rule cannot satisfy it. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')

test('a link is not styled to look like ordinary text', () => {
  const anchorRule = rules.match(/(^|\})\s*a\s*\{([^}]*)\}/)
  assert.ok(anchorRule, 'the stylesheet must say something about links')
  const body = anchorRule[2]
  assert.doesNotMatch(
    body,
    /text-decoration:\s*none/,
    'a bare `a` rule must not remove the underline; on a phone there is no hover state and nothing else says a link is pressable',
  )
  assert.doesNotMatch(
    body,
    /color:\s*inherit/,
    'a bare `a` rule must not take the surrounding text colour',
  )
})

test('the reset does not strip the spacing off everything', () => {
  // The scaffold's `* { padding: 0; margin: 0 }` is the specific rule that
  // flattened every page into one block.
  const universal = rules.match(/(^|\})\s*\*\s*\{([^}]*)\}/)
  if (universal) {
    assert.doesNotMatch(universal[2], /margin:\s*0/, 'the universal selector must not zero every margin')
    assert.doesNotMatch(universal[2], /padding:\s*0/, 'the universal selector must not zero every padding')
  }
})

test('the content is held off the edge of the screen and to a readable width', () => {
  const shell = rules.match(/\.shell\s*\{([^}]*)\}/)
  assert.ok(shell, 'there must be a rule for the page shell')
  assert.match(shell[1], /padding:/, 'the shell must have padding, or text touches the screen edge')
  assert.match(shell[1], /max-width:/, 'the shell must cap the line length')
})

test('the layout makes no third-party request for a font', () => {
  // ITERATION-0-SPEC asked for this import to be removed so the build makes no
  // third-party request. It had also been downloading two font files on every
  // page view that no rule ever used, because globals.css sets its own stack.
  assert.doesNotMatch(layout, /next\/font/, 'the layout must not load a font from a third party')
})

test('every page carries a way out, on every kind of page', async () => {
  // A prerendered page, a dynamic one, a redirect target and the 404, because
  // the frame is in the layout and a page that opted out would lose it.
  for (const path of ['/', '/privacy', '/sign-in', '/deleted', '/no-such-page']) {
    const r = await fetch(`${BASE}${path}`, { redirect: 'manual' })
    const text = visibleText(await r.text())
    assert.ok(text.includes('Canadian Recompete Radar'), `${path} must carry the business name`)
    assert.ok(
      text.includes('PO Box 1184, Pembroke, Ontario K8A 6Y6'),
      `${path} must carry the mailing address`,
    )
    const html = await (await fetch(`${BASE}${path}`, { redirect: 'manual' })).text()
    assert.match(html, /href="\/privacy"/, `${path} must link to the privacy policy`)
    assert.match(html, /href="https:\/\/recompeteradar\.ca"/, `${path} must link back to the public site`)
  }
})
