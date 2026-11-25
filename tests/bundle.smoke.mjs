/**
 * Smoke test for the built artifact (`lib/index.js`), not the sources.
 *
 * Confirms the bundle loads as ESM, validates an empty configuration through the
 * exported schemastery `Config`, and mounts all eight tools against a fake
 * context. Run after a build:
 *
 *   node tests/bundle.smoke.mjs
 */

const failures = []
let checks = 0

function ok(label, condition, detail = '') {
  checks += 1
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
}

process.env.CNBLOGS_PAT = ''
process.env.CNBLOGS_TOKEN = ''

const module = await import('../lib/index.js')

ok('the bundle exports a plugin name', module.name === 'dsh-cnblogs')
ok('the bundle requires only the tool registry', Array.isArray(module.inject) && module.inject.includes('tools'))
ok('the bundle exports a configuration schema', typeof module.Config === 'function')
ok('the bundle exports apply()', typeof module.apply === 'function')
ok('the bundle ships the usage text', typeof module.USAGE_TEXT === 'string' && module.USAGE_TEXT.includes('cnblogs_save_post'))

const resolved = module.Config({})
ok('an empty row configuration validates', resolved.enabled === true && resolved.defaultStatus === 'draft')
ok('the backend URLs have defaults', String(resolved.blogBackend).startsWith('https://write.cnblogs.com'))

const registered = []
const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  inject: () => () => {},
  get: () => undefined,
}
module.apply(ctx, { stateDir: process.env.TEMP ?? '/tmp' })
ok('all eight tools mount from the bundle', registered.length === 8, registered.map((tool) => tool.name).join(','))
ok('every registered tool has a description', registered.every((tool) => typeof tool.description === 'string' && tool.description.length > 20))
ok('every registered tool has an output schema', registered.every((tool) => tool.output !== undefined && tool.output.schema !== undefined))

process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`${failures.length} of ${checks} checks failed:\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`all ${checks} checks passed\n`)
}
