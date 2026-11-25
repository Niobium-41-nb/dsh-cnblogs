/**
 * Post orchestration: turn a markdown file (or inline text) into a backend post.
 *
 * The order matters and mirrors the official extension: read the source, split
 * the front matter, load the template (new post) or the stored post (update),
 * rehost images, save, then read the post back. The read-back is this plugin's
 * own addition — the extension trusts the save response, and "it said ok" is not
 * the same as "the blog shows what I sent".
 * @module dsh-cnblogs/posts
 */

import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { CnbApi, flattenCategories, normalizeUrl } from './api.ts'
import { normalizeAccess, normalizeStatus } from './config.ts'
import { fmBool, fmList, fmNumber, fmText, parseFrontMatter } from './frontmatter.ts'
import { findImageRefs, rehostImages } from './images.ts'
import type { StateStore } from './store.ts'
import { ACCESS_PERMISSION } from './types.ts'
import type {
  AccessLevel, CnbPost, Config, PostListItem, PostState, PostStatus,
} from './types.ts'

/** Outcome of the post-save read-back. */
export type Verification = 'ok' | 'title-mismatch' | 'body-mismatch' | 'unchecked'

/** Caller input for one save. Every content field is optional: front matter fills the gaps. */
export interface SaveInput {
  postId?: number
  /** Local markdown file; its directory anchors relative image paths. */
  file?: string
  title?: string
  /** Inline markdown. Ignored when `file` is set. */
  body?: string
  tags?: string[]
  /** Category names or ids. */
  categories?: (string | number)[]
  status?: PostStatus
  access?: AccessLevel
  slug?: string
  summary?: string
  pinned?: boolean
  comments?: boolean
  /** Per-call override of the plugin's image rehosting switch. */
  extractImages?: boolean
}

/** What `savePost` reports. */
export interface SaveResult {
  action: 'created' | 'updated'
  postId: number
  url: string
  title: string
  state: PostState
  access: AccessLevel
  tags: string[]
  categoryIds: number[]
  imagesUploaded: number
  imagesFailed: string[]
  verified: Verification
  bodyChars: number
  warnings: string[]
}

/** Everything a caller needs from one stored post. */
export interface PostDetail {
  postId: number
  title: string
  url: string
  state: PostState
  access: AccessLevel
  isMarkdown: boolean
  entryName: string
  tags: string[]
  categoryIds: number[]
  datePublished: string
  dateUpdated: string
  body: string
  bodyChars: number
  bodyTruncated: boolean
}

/** A page of posts, already projected to the fields the model needs. */
export interface PostPage {
  postsCount: number
  pageIndex: number
  pageSize: number
  pageCount: number
  posts: PostListItem[]
}

/** Derived publication state. */
export function postState(post: Pick<CnbPost, 'isDraft' | 'isPublished'>): PostState {
  if (post.isPublished) return 'published'
  if (post.isDraft) return 'draft'
  return 'unpublished'
}

/** Map `accessPermission` back to the vocabulary a caller uses. */
export function accessLevel(permission: number): AccessLevel {
  if (permission === ACCESS_PERMISSION.owner) return 'owner'
  if (permission === ACCESS_PERMISSION.login) return 'login'
  return 'public'
}

/** Compare bodies the way a human would: line endings and trailing space do not count. */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '')
}

/** Path of the public post page, derived from the account's blog app. */
export function publicUrl(blogApp: string, postId: number): string {
  return blogApp.length === 0 ? '' : `https://www.cnblogs.com/${blogApp}/p/${postId}.html`
}

/** True when the markdown still needs a local image upload to render. */
export function hasUnrehostedImages(body: string): boolean {
  return findImageRefs(body).some((ref) => {
    const url = ref.url.trim()
    if (url.length === 0) return false
    if (/^data:/i.test(url)) return true
    if (/^https?:\/\//i.test(url)) return false
    return true
  })
}

/** Flatten the category tree into `name → id` lookups. */
export function categoryIndex(nodes: ReturnType<typeof flattenCategories>): Map<string, number[]> {
  const index = new Map<string, number[]>()
  for (const node of nodes) {
    const key = node.title.trim().toLowerCase()
    if (key.length === 0) continue
    const ids = index.get(key)
    if (ids === undefined) index.set(key, [node.categoryId])
    else ids.push(node.categoryId)
  }
  return index
}

/** Resolve category names or ids against the blog's own list. */
export async function resolveCategoryIds(
  api: CnbApi,
  wanted: readonly (string | number)[],
  signal?: AbortSignal,
): Promise<number[]> {
  if (wanted.length === 0) return []
  const nodes = flattenCategories(await api.listCategories(signal))
  const index = categoryIndex(nodes)
  const names = nodes.map((node) => node.title).filter((title) => title.length > 0)
  const resolved: number[] = []
  for (const item of wanted) {
    if (typeof item === 'number') {
      if (!nodes.some((node) => node.categoryId === item)) {
        throw new Error(`unknown category id ${item}; available: ${names.slice(0, 20).join(', ')}`)
      }
      resolved.push(item)
      continue
    }
    const name = item.trim()
    if (name.length === 0) continue
    if (/^\d+$/.test(name)) {
      const numeric = Number(name)
      if (nodes.some((node) => node.categoryId === numeric)) {
        resolved.push(numeric)
        continue
      }
    }
    const matches = index.get(name.toLowerCase())
    if (matches === undefined || matches.length === 0) {
      throw new Error(`unknown category "${name}"; available: ${names.slice(0, 20).join(', ')}`)
    }
    const first = matches[0]
    if (first === undefined) continue
    if (matches.length > 1) throw new Error(`category "${name}" matches ${matches.length} categories; pass the numeric id instead`)
    resolved.push(first)
  }
  return [...new Set(resolved)]
}

interface LoadedSource {
  text: string
  filePath: string
  fileDir: string
}

/** Read the post source, rejecting a missing file and an oversized body early. */
export function loadSource(input: SaveInput, config: Config, cwd: string = process.cwd()): LoadedSource {
  if (input.file === undefined || input.file.trim().length === 0) {
    return { text: input.body ?? '', filePath: '', fileDir: cwd }
  }
  const filePath = resolve(input.file)
  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    throw new Error(`post file not found: ${filePath}`)
  }
  if (size > config.maxBodyChars * 8) {
    throw new Error(`post file is ${size} bytes, above the ${config.maxBodyChars * 8}-byte limit`)
  }
  return { text: readFileSync(filePath, 'utf8'), filePath, fileDir: dirname(filePath) }
}

/** Deduplicate a tag list while preserving order. */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length === 0) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    output.push(trimmed)
  }
  return output
}

export interface SaveContext {
  api: CnbApi
  store: StateStore
  config: Config
  input: SaveInput
  signal?: AbortSignal
}

/** Create or update one post, then read it back to report what the blog stored. */
export async function savePost(context: SaveContext): Promise<SaveResult> {
  const { api, store, config, input, signal } = context
  const warnings: string[] = []

  const source = loadSource(input, config)
  if (source.text.trim().length === 0) throw new Error('refusing to save an empty post body')
  if (source.text.length > config.maxBodyChars) {
    throw new Error(`post body is ${source.text.length} characters, above maxBodyChars (${config.maxBodyChars})`)
  }

  const frontMatter = parseFrontMatter(source.text)
  const fmStatus = normalizeStatus(fmText(frontMatter.data, ['status']))
    ?? (fmBool(frontMatter.data, ['draft']) === true ? 'draft' : undefined)
    ?? (fmBool(frontMatter.data, ['draft']) === false ? 'publish' : undefined)
  const fmAccess = normalizeAccess(fmText(frontMatter.data, ['access', 'accesslevel', 'permission']))
  const fmTitle = fmText(frontMatter.data, ['title'])
  const fmTags = fmList(frontMatter.data, ['tags', 'tag'])
  const fmCategories = fmList(frontMatter.data, ['categories', 'category'])
  const fmPostId = fmNumber(frontMatter.data, ['postid', 'post_id'])
  const fmSlug = fmText(frontMatter.data, ['slug', 'entryname'])
  const fmSummary = fmText(frontMatter.data, ['summary', 'description'])
  const fmPinned = fmBool(frontMatter.data, ['pinned', 'ispinned'])
  const fmComments = fmBool(frontMatter.data, ['comments', 'allowcomments'])

  const body = config.keepFrontMatter ? source.text : frontMatter.body

  const mapped = source.filePath === '' ? undefined : store.getFile(source.filePath)
  const postId = input.postId ?? fmPostId ?? (mapped === undefined ? undefined : mapped.postId)
  const creating = postId === undefined

  const base = creating === true ? await api.getTemplate(signal) : await api.getPost(postId as number, signal)
  if (creating === false && base.isMarkdown === false) {
    warnings.push('the stored post is HTML; this save writes markdown, so the post format changes')
  }

  const fallbackTitle = source.filePath === '' ? '' : basename(source.filePath).replace(/\.[^.\\/]+$/, '')
  const title = (input.title ?? fmTitle ?? fallbackTitle).trim()
  if (title.length === 0) {
    throw new Error('a post title is required: pass `title`, add `title:` to the front matter, or name the file after the post')
  }

  const post: CnbPost = { ...base }
  post.id = creating === true ? -1 : base.id
  post.title = title
  post.postBody = body
  post.isMarkdown = true

  const tags = input.tags ?? fmTags
  if (tags !== undefined) post.tags = dedupe(tags)

  const categories = input.categories ?? fmCategories
  if (categories !== undefined) post.categoryIds = await resolveCategoryIds(api, categories, signal)

  if (input.slug !== undefined || fmSlug !== undefined) post.entryName = (input.slug ?? fmSlug ?? '').trim()
  if (input.summary !== undefined || fmSummary !== undefined) post.description = input.summary ?? fmSummary ?? ''
  if (input.pinned !== undefined || fmPinned !== undefined) post.isPinned = input.pinned ?? fmPinned ?? false
  if (input.comments !== undefined || fmComments !== undefined) post.isAllowComments = input.comments ?? fmComments ?? true

  const status = input.status ?? fmStatus ?? (creating === true ? config.defaultStatus : undefined)
  if (status === 'publish') {
    post.isDraft = false
    post.isPublished = true
  } else if (status === 'draft') {
    post.isDraft = true
    post.isPublished = false
  }

  const access = input.access ?? fmAccess ?? (creating === true ? config.defaultAccess : undefined)
  if (access !== undefined) post.accessPermission = ACCESS_PERMISSION[access]

  let imagesUploaded = 0
  const imagesFailed: string[] = []
  const extract = (input.extractImages ?? config.extractImages) && post.isMarkdown
  if (extract) {
    const result = await rehostImages({ body: post.postBody, fileDir: source.fileDir, api, config, signal })
    post.postBody = result.body
    imagesUploaded = result.uploaded.length
    for (const failure of result.failed) {
      imagesFailed.push(`${failure.from}: ${failure.error}`)
      warnings.push(`image left unchanged (${failure.from}): ${failure.error}`)
    }
  } else if (hasUnrehostedImages(post.postBody)) {
    warnings.push('the markdown still references local or data-URL images and image extraction is off; '
      + 'readers will see broken images until they are uploaded')
  }

  const saved = await api.savePost(post, signal)

  let verified: Verification = 'unchecked'
  try {
    const stored = await api.getPost(saved.id, signal)
    const titleMatches = stored.title.trim() === title.trim()
    const bodyMatches = normalizeBody(stored.postBody) === normalizeBody(post.postBody)
    verified = titleMatches === false ? 'title-mismatch' : bodyMatches === false ? 'body-mismatch' : 'ok'
    if (bodyMatches === false) {
      warnings.push('the stored body differs from the markdown that was sent; read it back with cnblogs_get_post before trusting the result')
    }
    if (titleMatches === false) warnings.push(`the stored title is "${stored.title}"`)
  } catch (error) {
    warnings.push(`post-save verification skipped: ${error instanceof Error ? error.message : String(error)}`)
  }

  const url = saved.url.length > 0 ? saved.url : ''
  if (source.filePath !== '') {
    store.setFile(source.filePath, {
      postId: saved.id,
      url,
      title: saved.title,
      updatedAt: new Date().toISOString(),
    })
  }

  return {
    action: creating === true ? 'created' : 'updated',
    postId: saved.id,
    url,
    title: saved.title,
    state: postState(post),
    access: accessLevel(post.accessPermission),
    tags: post.tags,
    categoryIds: post.categoryIds,
    imagesUploaded,
    imagesFailed,
    verified,
    bodyChars: post.postBody.length,
    warnings,
  }
}

/** One page of posts, with `pageCount` computed from the reported total. */
export async function listPosts(
  api: CnbApi,
  input: { page?: number; pageSize?: number; search?: string; categoryId?: number; signal?: AbortSignal },
): Promise<PostPage> {
  const model = await api.listPosts(input)
  const pageSize = model.pageSize > 0 ? model.pageSize : Math.max(model.postList.length, 1)
  return {
    postsCount: model.postsCount,
    pageIndex: model.pageIndex,
    pageSize,
    pageCount: Math.max(1, Math.ceil(model.postsCount / pageSize)),
    posts: model.postList,
  }
}

/** Read one post, truncating an oversized body instead of blowing up the context. */
export async function getPostDetail(
  api: CnbApi,
  postId: number,
  maxBodyChars: number,
  signal?: AbortSignal,
): Promise<PostDetail> {
  const post = await api.getPost(postId, signal)
  const body = post.postBody
  const truncated = body.length > maxBodyChars
  return {
    postId: post.id > 0 ? post.id : postId,
    title: post.title,
    url: normalizeUrl(typeof post.url === 'string' ? post.url : ''),
    state: postState(post),
    access: accessLevel(post.accessPermission),
    isMarkdown: post.isMarkdown,
    entryName: post.entryName,
    tags: post.tags,
    categoryIds: post.categoryIds,
    datePublished: typeof post.datePublished === 'string' ? post.datePublished : '',
    dateUpdated: typeof post.dateUpdated === 'string' ? post.dateUpdated : '',
    body: truncated ? body.slice(0, maxBodyChars) : body,
    bodyChars: body.length,
    bodyTruncated: truncated,
  }
}

/** Delete posts one by one so one failure does not hide the rest. */
export async function deletePosts(
  api: CnbApi,
  postIds: readonly number[],
  signal?: AbortSignal,
): Promise<{ deleted: number[]; failed: { id: number; error: string }[] }> {
  const deleted: number[] = []
  const failed: { id: number; error: string }[] = []
  for (const postId of postIds) {
    try {
      await api.deletePost(postId, signal)
      deleted.push(postId)
    } catch (error) {
      failed.push({ id: postId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { deleted, failed }
}
