/**
 * Diagnostic: report the response shape of every read endpoint the plugin uses.
 *
 * Prints only HTTP status and structural shape (keys and lengths), never values,
 * so it is safe to paste into a conversation. Run it after a backend change:
 *
 *   node --experimental-strip-types scripts/probe-shapes.mjs
 */

import { resolveConfig } from '../src/config.ts'
import { AuthStore } from '../src/auth.ts'

const config = resolveConfig({})
const auth = new AuthStore({ config, env: process.env })
const resolved = await auth.resolve()
if (resolved === undefined) {
  process.stderr.write('no token configured\n')
  process.exit(2)
}

const headers = { authorization: `Bearer ${resolved.token}` }
if (!resolved.token.includes('.')) headers['authorization-type'] = 'pat'

const targets = [
  ['users', `${config.openapi}/users`],
  ['posts/list', `${config.blogBackend}/posts/list?t=1&p=1&s=1`],
  ['post/-1 (template)', `${config.blogBackend}/posts/-1`],
  ['categories', `${config.blogBackend}/v2/blog-category-types/1/categories`],
  ['tags', `${config.blogBackend}/tags/list`],
  ['statuses/@4', `${config.openapi}/statuses/@4?pageIndex=1&pageSize=1`],
  ['blogExports', `${config.blogBackend}/blogExports?pageIndex=1&pageSize=1`],
]

function describe(value) {
  if (Array.isArray(value)) return `array(${value.length})`
  if (value === null) return 'null'
  if (typeof value !== 'object') return typeof value
  const keys = Object.keys(value)
  const nested = keys
    .map((key) => (Array.isArray(value[key]) ? `${key}:array(${value[key].length})` : null))
    .filter((part) => part !== null)
  return `object{${keys.join(',')}}${nested.length > 0 ? ` [${nested.join(' ')}]` : ''}`
}

for (const [name, url] of targets) {
  try {
    const response = await fetch(url, { headers })
    const text = await response.text()
    let shape = 'non-json'
    try {
      shape = describe(JSON.parse(text))
    } catch {
      shape = `non-json(${text.slice(0, 40).replace(/\s+/g, ' ')})`
    }
    process.stdout.write(`${name.padEnd(20)} HTTP ${response.status}  ${shape}\n`)
  } catch (error) {
    process.stdout.write(`${name.padEnd(20)} FAILED ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
