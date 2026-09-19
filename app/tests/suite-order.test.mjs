// The test files must run one at a time.
//
// Every test file that writes to the database empties shared tables at the
// start and end of each case: helpers.truncateAll truncates events and the
// tables that describe people, and scanner-schema's clearScannerTables deletes
// every events row. Node runs test files in parallel by default, and two at
// once would delete each other's rows, which gives failures that are not real,
// or passes for the wrong reason. The flag in package.json is what stops that,
// and until 18 September 2026 nothing said so (outside review).
//
// Reading package.json is the whole check, so it runs anywhere.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the test files run one at a time', () => {
  const script = pkg.scripts?.test ?? ''
  assert.match(script, /--test-concurrency[= ]1(\s|$)/,
    `the test script must pin --test-concurrency=1; it is "${script}"`)
})
