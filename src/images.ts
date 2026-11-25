/**
 * Image discovery and rehosting.
 *
 * A post that references `./screenshot.png` or a `data:` URL renders broken on
 * cnblogs, so the referenced bytes are uploaded to the blog's own image store
 * and the markdown is rewritten before the post is saved. Images already on a
 * `*.cnblogs.com` host are left alone; third-party images are only rehosted when
 * `extractWebImages` says so.
 * @module dsh-cnblogs/images
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { CnbApi } from './api.ts'
import type { Config } from './types.ts'

/** One image reference, with the exact range of its URL inside the document. */
export interface ImageRef {
  /** Offset of the first URL character. */
  start: number
  /** Offset just past the last URL character. */
  end: number
  /** The URL or path as written. */
  url: string
  /** Markdown `![]()` or HTML `<img src>`. */
  kind: 'markdown' | 'html'
}

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^\s)]+))/g
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

/** Ranges covered by fenced code blocks and inline code spans. */
export function codeRanges(body: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  const fences = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm
  let open: { start: number; char: string; length: number } | undefined
  for (const match of body.matchAll(fences)) {
    const marker = match[1] ?? ''
    const start = match.index ?? 0
    const end = start + match[0].length
    if (open === undefined) {
      open = { start, char: marker[0] ?? '`', length: marker.length }
      continue
    }
    if (marker[0] === open.char && marker.length >= open.length) {
      ranges.push({ start: open.start, end })
      open = undefined
    }
  }
  // An unterminated fence makes the rest of the document code.
  if (open !== undefined) ranges.push({ start: open.start, end: body.length })

  const inline = /(`+)([^`\n]*)\1/g
  for (const match of body.matchAll(inline)) {
    const start = match.index ?? 0
    if (ranges.some((range) => start >= range.start && start < range.end)) continue
    ranges.push({ start, end: start + match[0].length })
  }
  return ranges.sort((left, right) => left.start - right.start)
}

/** Every image reference in a markdown/HTML document, in document order. */
export function findImageRefs(body: string): ImageRef[] {
  const code = codeRanges(body)
  const refs: ImageRef[] = []
  for (const match of body.matchAll(MARKDOWN_IMAGE)) {
    const angleWrapped = match[1]
    const raw = angleWrapped ?? match[2] ?? ''
    if (raw.length === 0) continue
    const end = (match.index ?? 0) + match[0].length - (angleWrapped === undefined ? 0 : 1)
    refs.push({ start: end - raw.length, end, url: raw, kind: 'markdown' })
  }
  for (const match of body.matchAll(HTML_IMAGE)) {
    const raw = match[1] ?? match[2] ?? ''
    if (raw.length === 0) continue
    const valueEnd = (match.index ?? 0) + match[0].length - 1
    refs.push({ start: valueEnd - raw.length, end: valueEnd, url: raw, kind: 'html' })
  }
  return refs
    .filter((ref) => !code.some((range) => ref.start >= range.start && ref.end <= range.end))
    .sort((left, right) => left.start - right.start)
}

/** Replace ranges; `replacements` must carry the original text. */
export function applyReplacements(body: string, replacements: readonly { from: ImageRef; to: string }[]): string {
  const ordered = [...replacements].sort((left, right) => right.from.start - left.from.start)
  let output = body
  for (const { from, to } of ordered) output = output.slice(0, from.start) + to + output.slice(from.end)
  return output
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
}

/** MIME type for an image path, or undefined when the extension is not an image. */
export function mimeForPath(path: string): string | undefined {
  return MIME_BY_EXT[extname(path).toLowerCase()]
}

/** Result of rewriting a document's images. */
export interface RehostResult {
  body: string
  uploaded: { from: string; to: string; bytes: number }[]
  failed: { from: string; error: string }[]
  skipped: { from: string; reason: string }[]
}

export interface RehostOptions {
  body: string
  /** Directory relative image paths resolve against. */
  fileDir: string
  api: CnbApi
  config: Config
  signal?: AbortSignal
}

/** True when a URL already points at the blog's own image host. */
export function isCnblogsHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname === 'cnblogs.com' || hostname.endsWith('.cnblogs.com')
  } catch {
    return false
  }
}

/** A local image path from a markdown link, made absolute. */
export function resolveLocalImagePath(raw: string, fileDir: string): string {
  let path = raw
  if (path.startsWith('file://')) path = path.slice('file://'.length)
  path = path.replace(/[?#].*$/, '')
  try {
    path = decodeURIComponent(path)
  } catch {
    // Keep the raw text when it is not valid percent-encoding.
  }
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')) return path
  return join(fileDir, path)
}

/** Upload every rehostable image and rewrite the document to point at the blog. */
export async function rehostImages(options: RehostOptions): Promise<RehostResult> {
  const { body, fileDir, api, config, signal } = options
  const refs = findImageRefs(body)
  const byUrl = new Map<string, ImageRef[]>()
  for (const ref of refs) {
    const list = byUrl.get(ref.url)
    if (list === undefined) byUrl.set(ref.url, [ref])
    else list.push(ref)
  }

  const uploaded: RehostResult['uploaded'] = []
  const failed: RehostResult['failed'] = []
  const skipped: RehostResult['skipped'] = []
  const replacements: { from: ImageRef; to: string }[] = []

  for (const [url, group] of byUrl) {
    const target = url.trim()
    if (target.length === 0) continue
    try {
      let bytes: Uint8Array
      let mime: string
      let filename: string

      if (/^data:/i.test(target)) {
        const parsed = parseDataUrl(target)
        if (parsed === undefined) {
          skipped.push({ from: url, reason: 'unsupported data URL' })
          continue
        }
        bytes = parsed.bytes
        mime = parsed.mime
        filename = `image.${extensionForMime(mime)}`
      } else if (/^https?:\/\//i.test(target)) {
        if (isCnblogsHost(target)) {
          skipped.push({ from: url, reason: 'already hosted on cnblogs' })
          continue
        }
        if (!config.extractWebImages) {
          skipped.push({ from: url, reason: 'third-party image kept (extractWebImages is off)' })
          continue
        }
        const downloaded = await api.downloadImage(target, config.maxUploadBytes, signal)
        bytes = downloaded.bytes
        mime = downloaded.mime
        filename = `image.${extensionForMime(mime)}`
      } else {
        const path = resolveLocalImagePath(target, fileDir)
        const mimeType = mimeForPath(path)
        if (mimeType === undefined) {
          skipped.push({ from: url, reason: 'local path is not a known image type' })
          continue
        }
        if (!existsSync(path)) {
          failed.push({ from: url, error: `local file not found: ${path}` })
          continue
        }
        const size = statSync(path).size
        if (size > config.maxUploadBytes) {
          failed.push({ from: url, error: `local file is ${size} bytes, above maxUploadBytes` })
          continue
        }
        bytes = readFileSync(path)
        mime = mimeType
        filename = basename(path)
        if (filename.length === 0) filename = `image.${extensionForMime(mime)}`
      }

      if (bytes.byteLength > config.maxUploadBytes) {
        failed.push({ from: url, error: `image is ${bytes.byteLength} bytes, above maxUploadBytes` })
        continue
      }
      const remote = await api.uploadImage(bytes, mime, filename)
      for (const ref of group) replacements.push({ from: ref, to: remote })
      uploaded.push({ from: url, to: remote, bytes: bytes.byteLength })
    } catch (error) {
      failed.push({ from: url, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { body: applyReplacements(body, replacements), uploaded, failed, skipped }
}

/** Decode a base64 `data:` URL. */
export function parseDataUrl(value: string): { bytes: Uint8Array; mime: string } | undefined {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]*)$/i.exec(value)
  if (match === null) return undefined
  const mime = (match[1] ?? 'image/png').toLowerCase()
  if (!mime.startsWith('image/')) return undefined
  const base64 = (match[2] ?? '').replace(/\s/g, '')
  if (base64.length === 0) return undefined
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'))
  if (bytes.byteLength === 0) return undefined
  return { bytes, mime }
}

/** File extension for the image MIME types cnblogs accepts. */
export function extensionForMime(mime: string): string {
  const lowered = mime.toLowerCase()
  for (const [ext, value] of Object.entries(MIME_BY_EXT)) {
    if (value === lowered) return ext.slice(1)
  }
  return 'png'
}
