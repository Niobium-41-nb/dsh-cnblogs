/**
 * YAML front matter for post files.
 *
 * Deliberately a small subset — `key: value`, quoted strings, inline `[a, b]`
 * lists, `- item` block lists, booleans and numbers. The extension keeps the
 * block verbatim; this plugin strips it from the uploaded body (a `---` rule
 * renders as a horizontal line on the blog) and reads the fields it knows.
 * @module dsh-cnblogs/frontmatter
 */

export type FrontMatterValue = string | string[] | boolean | number

export interface FrontMatter {
  /** Whether a closed `---` block opened the document. */
  present: boolean
  /** Parsed keys, original casing. */
  data: Record<string, FrontMatterValue>
  /** Everything after the block. */
  body: string
}

/** The opening and closing fence, tolerating CRLF and a trailing EOF. */
const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

/** Split an inline `[a, b]` list. */
function splitFlow(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote = ''
  for (const char of value) {
    if (quote !== '') {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ',') {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim().length > 0) parts.push(current.trim())
  return parts.filter((part) => part.length > 0)
}

/** Decode one scalar token. */
function parseScalar(raw: string): FrontMatterValue {
  const value = raw.trim()
  if (value.length === 0) return ''
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    const inner = value.slice(1, -1)
    return value.startsWith('"') ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner
  }
  if (value.startsWith('[') && value.endsWith(']')) return splitFlow(value.slice(1, -1))
  if (/^(true|yes|on)$/i.test(value)) return true
  if (/^(false|no|off)$/i.test(value)) return false
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  return value
}

/** Parse the block body into key/value pairs. */
function parseBlock(block: string): Record<string, FrontMatterValue> {
  const data: Record<string, FrontMatterValue> = {}
  let currentKey = ''
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const item = /^-[ \t]+(.*)$/.exec(trimmed)
    if (item !== null && currentKey !== '') {
      const existing = data[currentKey]
      const list = Array.isArray(existing) ? existing : typeof existing === 'string' && existing.length > 0 ? [existing] : []
      list.push(String(parseScalar(item[1] ?? '')))
      data[currentKey] = list
      continue
    }
    const pair = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*)$/.exec(trimmed)
    if (pair === null) continue
    currentKey = pair[1] ?? ''
    if (currentKey === '') continue
    const rawValue = pair[2] ?? ''
    data[currentKey] = rawValue.trim().length === 0 ? [] : parseScalar(rawValue)
  }
  // An empty value stays an empty list only when block items followed; otherwise
  // it is an empty string, which is what a `title:` with no value means.
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length === 0) data[key] = ''
  }
  return data
}

/** Split an optional leading front matter block from the document. */
export function parseFrontMatter(text: string): FrontMatter {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text
  const match = FENCE.exec(withoutBom)
  if (match === null) return { present: false, data: {}, body: withoutBom }
  // A removed block usually leaves a blank line behind; drop it so the published
  // post does not open with an empty paragraph.
  const body = withoutBom.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, '')
  return { present: true, data: parseBlock(match[1] ?? ''), body }
}

/** Case-insensitive lookup of the first matching key. */
function lookup(data: Record<string, FrontMatterValue>, keys: readonly string[]): FrontMatterValue | undefined {
  const wanted = keys.map((key) => key.toLowerCase())
  for (const [key, value] of Object.entries(data)) {
    if (wanted.includes(key.toLowerCase())) return value
  }
  return undefined
}

/** First matching value coerced to text. */
export function fmText(data: Record<string, FrontMatterValue>, keys: readonly string[]): string | undefined {
  const value = lookup(data, keys)
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : undefined
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.length > 0 ? value.join(',') : undefined
  return undefined
}

/** First matching value coerced to a list (`a, b` in a scalar is accepted). */
export function fmList(data: Record<string, FrontMatterValue>, keys: readonly string[]): string[] | undefined {
  const value = lookup(data, keys)
  if (Array.isArray(value)) {
    const items = value.map((item) => item.trim()).filter((item) => item.length > 0)
    return items.length > 0 ? items : undefined
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  }
  return undefined
}

/** First matching value coerced to a boolean. */
export function fmBool(data: Record<string, FrontMatterValue>, keys: readonly string[]): boolean | undefined {
  const value = lookup(data, keys)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (/^(true|yes|on|1)$/i.test(value)) return true
    if (/^(false|no|off|0)$/i.test(value)) return false
  }
  return undefined
}

/** First matching value coerced to a positive integer. */
export function fmNumber(data: Record<string, FrontMatterValue>, keys: readonly string[]): number | undefined {
  const value = lookup(data, keys)
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
