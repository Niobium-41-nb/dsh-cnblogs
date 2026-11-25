/**
 * Create the token file this plugin reads, so the path reported by
 * `cnblogs_account` exists and can be filled in.
 *
 *   node --experimental-strip-types scripts/init-token.mjs
 *
 * Prints `created` on the first run and `present` afterwards; an existing file is
 * never overwritten.
 */

import { resolveConfig, resolveTokenPath } from '../src/config.ts'
import { ensureTokenTemplate } from '../src/auth.ts'

const config = resolveConfig({})
const path = resolveTokenPath(config)
const state = ensureTokenTemplate(path)

process.stdout.write(`${state}: ${path}\n`)
if (state === 'skipped') {
  process.stderr.write('could not create the file; create the directory yourself and put the token in it\n')
  process.exit(1)
}
process.stdout.write('paste the token on its own line, save, then run `cnblogs_account` action `status`\n')
