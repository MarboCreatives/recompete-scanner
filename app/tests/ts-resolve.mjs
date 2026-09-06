// Lets a .mjs check import a .ts module from src/lib.
//
// Node strips TypeScript types on its own, so importing a single .ts file works
// already; that is how email-agreement.test.mjs reaches normalize-email.ts. It
// only works because that file imports nothing. Anything under src/lib that
// imports a sibling writes `from './env'`, with no extension, which is legal
// TypeScript and is not a legal ESM specifier. Node answers ERR_MODULE_NOT_FOUND
// and the import fails before any check runs. Measured, not assumed.
//
// So relative specifiers get a `.ts` retry. The hook is deliberately narrow: it
// touches only './' and '../' specifiers, it tries the unmodified specifier
// first, and it never invents a path for a bare package name. A hook that
// guessed more widely could resolve something other than the file under test,
// which would make every check downstream of it worthless.
//
// registerHooks is synchronous and runs in this thread, unlike module.register,
// so a check can call it at the top of the file and import immediately after.
//
// This module proves itself on load; see checkHookWorks below. A resolver that
// silently stopped resolving would otherwise turn every check that depends on
// it into a check that cannot fail.

import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Absolute path of a module in src/lib, as a file:// URL Node will accept. */
export function libUrl(basename) {
  // A bare Windows absolute path is not a legal ESM specifier: it fails with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME because 'c:' is read as a protocol.
  return pathToFileURL(join(here, '..', 'src', 'lib', basename)).href
}

let registered = false

/** Install the resolver. Safe to call more than once. */
export function installTypeScriptResolver() {
  if (registered) return
  registered = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        try {
          return nextResolve(specifier, context)
        } catch {
          return nextResolve(specifier + '.ts', context)
        }
      }
      return nextResolve(specifier, context)
    },
  })
}

/**
 * Prove the resolver does the one thing it exists for, before anything relies
 * on it.
 *
 * email.ts is the case that matters: its first two lines import './env' and
 * './log' with no extension, which is exactly what fails without the hook.
 * Importing it and finding its export is therefore a real test of the resolver
 * and not a restatement of it. Without this, a hook that quietly stopped
 * resolving would turn every check downstream into one that cannot fail.
 */
export async function checkHookWorks() {
  installTypeScriptResolver()
  const mod = await import(libUrl('email.ts'))
  if (typeof mod.sendEmail !== 'function') {
    throw new Error('the TypeScript resolver is not working: email.ts loaded without sendEmail')
  }
}
