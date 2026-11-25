/**
 * The cnblogs HTTP API, as the official VS Code extension uses it.
 *
 * Two hosts matter: `write.cnblogs.com/api` for posts, categories, tags and image
 * uploads, and `api.cnblogs.com/api` for the account and 闪存. Both accept
 * `Authorization: Bearer <token>`; a personal access token additionally needs
 * `Authorization-Type: pat`, which the extension derives from the token shape.
 *
 * Every call observes `AbortSignal`, so a cancelled tool call stops the request.
 * @module dsh-cnblogs/api
 */

import type {
  Account, CategoryNode, CnbPost, Config, IngItem, PostListModel, PostUpdatedResp, Tag,
} from './types.ts'

/** A non-2xx response, or a response that could not be interpreted. */
export class CnbError extends Error {
  readonly status: number
  readonly detail: string

  constructor(message: string, status: number, detail: string) {
    super(message)
    this.name = 'CnbError'
    this.status = status
    this.detail = detail
  }
}

/** Keep a server body out of the model's context but available for diagnosis. */
function clip(value: string, limit = 400): string {
  const text = value.trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** Path + query of a URL, for error messages that must not leak headers. */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

/** Test seam: production uses the global `fetch`. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface ApiOptions {
  /** Override the HTTP implementation (tests). */
  fetchFn?: FetchLike
}

interface RequestOptions {
  method: string
  url: string
  body?: string | FormData
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** A post read is normalized so callers never see `null` where a list belongs. */
export function normalizePost(raw: unknown): CnbPost {
  const source = (raw ?? {}) as Record<string, unknown>
  const tags = Array.isArray(source.tags) ? source.tags.filter((tag): tag is string => typeof tag === 'string') : []
  const categoryIds = Array.isArray(source.categoryIds)
    ? source.categoryIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
    : []
  const post: CnbPost = {
    ...source,
    id: typeof source.id === 'number' ? source.id : -1,
    title: typeof source.title === 'string' ? source.title : '',
    postBody: typeof source.postBody === 'string' ? source.postBody : '',
    isMarkdown: source.isMarkdown !== false,
    isDraft: source.isDraft === true,
    isPublished: source.isPublished === true,
    postType: typeof source.postType === 'number' ? source.postType : 1,
    accessPermission: typeof source.accessPermission === 'number' ? source.accessPermission : 0,
    categoryIds,
    tags,
    entryName: typeof source.entryName === 'string' ? source.entryName : '',
    description: typeof source.description === 'string' ? source.description : '',
    isAllowComments: source.isAllowComments !== false,
    isPinned: source.isPinned === true,
    displayOnHomePage: source.displayOnHomePage !== false,
  }
  return post
}

/** Normalize the PascalCase account projection from `GET /users`. */
export function normalizeAccount(raw: unknown): Account {
  const source = (raw ?? {}) as Record<string, unknown>
  const text = (key: string): string => (typeof source[key] === 'string' ? (source[key] as string) : '')
  const number = (key: string): number => (typeof source[key] === 'number' ? (source[key] as number) : 0)
  return {
    userId: text('UserId') || text('userId'),
    spaceUserId: number('SpaceUserID') || number('spaceUserId'),
    blogId: number('BlogId') || number('blogId'),
    displayName: text('DisplayName') || text('displayName'),
    blogApp: text('BlogApp') || text('blogApp'),
    avatar: text('Avatar') || text('avatar'),
    isVip: source.IsVip === true || source.isVip === true,
    joined: text('Joined') || text('joined'),
  }
}

/** Normalize the post list, keeping only the fields the tools show. */
export function normalizePostList(raw: unknown): PostListModel {
  const source = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(source.postList) ? source.postList : []
  const postsCount = typeof source.postsCount === 'number' ? source.postsCount : list.length
  return {
    postsCount,
    pageIndex: typeof source.pageIndex === 'number' ? source.pageIndex : 1,
    pageSize: typeof source.pageSize === 'number' ? source.pageSize : list.length,
    postList: list.map((item) => normalizePostListItem(item)),
  }
}

/** Normalize one list row. */
export function normalizePostListItem(raw: unknown): PostListModel['postList'][number] {
  const source = (raw ?? {}) as Record<string, unknown>
  return {
    id: typeof source.id === 'number' ? source.id : -1,
    title: typeof source.title === 'string' ? source.title : '',
    url: normalizeUrl(typeof source.url === 'string' ? source.url : ''),
    entryName: typeof source.entryName === 'string' ? source.entryName : '',
    isDraft: source.isDraft === true,
    isPublished: source.isPublished === true,
    isMarkdown: source.isMarkdown !== false,
    postType: typeof source.postType === 'number' ? source.postType : 1,
    accessPermission: typeof source.accessPermission === 'number' ? source.accessPermission : 0,
    datePublished: typeof source.datePublished === 'string' ? source.datePublished : '',
    dateUpdated: typeof source.dateUpdated === 'string' ? source.dateUpdated : '',
    viewCount: typeof source.viewCount === 'number' ? source.viewCount : 0,
  }
}

/** `//host/path` → `https://host/path`; anything else is returned trimmed. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  return trimmed
}

/** Normalize one 闪存 row (the API answers in PascalCase). */
export function normalizeIng(raw: unknown): IngItem {
  const source = (raw ?? {}) as Record<string, unknown>
  const pick = (camel: string, pascal: string): unknown => source[camel] ?? source[pascal]
  const text = (camel: string, pascal: string): string => {
    const value = pick(camel, pascal)
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  }
  const number = (camel: string, pascal: string): number => {
    const value = pick(camel, pascal)
    return typeof value === 'number' ? value : 0
  }
  return {
    id: number('id', 'Id'),
    content: text('content', 'Content'),
    isPrivate: pick('isPrivate', 'IsPrivate') === true,
    dateAdded: text('dateAdded', 'DateAdded'),
    commentCount: number('commentCount', 'CommentCount'),
    userDisplayName: text('userDisplayName', 'UserDisplayName'),
    userAlias: text('userAlias', 'UserAlias'),
  }
}

/** Recursively flatten a category tree. */
export function flattenCategories(nodes: readonly CategoryNode[]): CategoryNode[] {
  const flat: CategoryNode[] = []
  const walk = (list: readonly CategoryNode[]): void => {
    for (const node of list) {
      flat.push(node)
      if (Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(nodes)
  return flat
}

/** Normalize one category node. */
export function normalizeCategory(raw: unknown): CategoryNode {
  const source = (raw ?? {}) as Record<string, unknown>
  const children = Array.isArray(source.children) ? source.children.map((child) => normalizeCategory(child)) : undefined
  const node: CategoryNode = {
    categoryId: typeof source.categoryId === 'number' ? source.categoryId : -1,
    title: typeof source.title === 'string' ? source.title : '',
    parentId: typeof source.parentId === 'number' ? source.parentId : null,
    visible: source.visible !== false,
    description: typeof source.description === 'string' ? source.description : '',
    itemCount: typeof source.itemCount === 'number' ? source.itemCount : 0,
  }
  if (children !== undefined) node.children = children
  return node
}

/**
 * Normalize the categories response.
 *
 * The live endpoint answers `{ categories: [...], parent }` — the official
 * extension destructures `{ categories }` too. A bare array is accepted because
 * that is the shape this plugin's own fixture uses, and an unexpected object
 * yields `[]` rather than a crash.
 */
export function normalizeCategories(raw: unknown): CategoryNode[] {
  if (Array.isArray(raw)) return raw.map((node) => normalizeCategory(node))
  if (raw !== null && typeof raw === 'object') {
    const source = raw as Record<string, unknown>
    for (const key of ['categories', 'items', 'data'] as const) {
      const list = source[key]
      if (Array.isArray(list)) return list.map((node) => normalizeCategory(node))
    }
  }
  return []
}

/** The cnblogs client. One instance per tool call; the token never leaves the host. */
export class CnbApi {
  readonly config: Config
  private readonly token: string
  private readonly fetchFn: FetchLike

  constructor(config: Config, token: string, options: ApiOptions = {}) {
    this.config = config
    this.token = token
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init))
  }

  /** Headers every request carries. */
  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    // OAuth access tokens are JWTs and carry dots; a PAT is opaque and needs the
    // backend's explicit marker, which is what the official extension sends.
    if (!this.token.includes('.')) headers['authorization-type'] = 'pat'
    return headers
  }

  /** One request with the configured deadline. */
  private async request(options: RequestOptions): Promise<{ text: string; contentType: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('request deadline exceeded')), this.config.timeoutMs)
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal])
    const headers = { ...this.authHeaders(), ...(options.headers ?? {}) }
    try {
      const init: RequestInit = { method: options.method, headers, signal, redirect: 'follow' }
      if (options.body !== undefined) init.body = options.body
      const response = await this.fetchFn(options.url, init)
      const text = await response.text()
      if (!response.ok) {
        throw new CnbError(
          `cnblogs ${options.method} ${describeUrl(options.url)} failed with HTTP ${response.status}`,
          response.status,
          clip(text),
        )
      }
      return { text, contentType: response.headers.get('content-type') ?? '' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** One request whose body must be JSON. */
  private async json<T>(options: RequestOptions): Promise<T> {
    const { text } = await this.request(options)
    if (text.trim().length === 0) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new CnbError(
        `cnblogs ${options.method} ${describeUrl(options.url)} returned a non-JSON body`,
        200,
        clip(text),
      )
    }
  }

  // --- account -------------------------------------------------------------

  /** The signed-in account; also the cheapest token check. */
  async getAccount(signal?: AbortSignal): Promise<Account> {
    const raw = await this.json<unknown>({ method: 'GET', url: `${this.config.openapi}/users`, signal })
    return normalizeAccount(raw)
  }

  // --- posts ---------------------------------------------------------------

  /** One page of the post list. */
  async listPosts(input: {
    page?: number
    pageSize?: number
    search?: string
    categoryId?: number
    signal?: AbortSignal
  }): Promise<PostListModel> {
    const params = new URLSearchParams({ t: '1', p: String(input.page ?? 1), s: String(input.pageSize ?? 20) })
    if (input.search !== undefined && input.search.length > 0) params.set('search', input.search)
    if (input.categoryId !== undefined) params.set('cid', String(input.categoryId))
    const raw = await this.json<unknown>({
      method: 'GET',
      url: `${this.config.blogBackend}/posts/list?${params.toString()}`,
      signal: input.signal,
    })
    return normalizePostList(raw)
  }

  /** The editing template the backend uses for a new post. */
  async getTemplate(signal?: AbortSignal): Promise<CnbPost> {
    const raw = await this.json<unknown>({ method: 'GET', url: `${this.config.blogBackend}/posts/-1`, signal })
    return normalizePost(extractPost(raw, 'template'))
  }

  /** One post, as editable data. */
  async getPost(postId: number, signal?: AbortSignal): Promise<CnbPost> {
    const raw = await this.json<unknown>({
      method: 'GET',
      url: `${this.config.blogBackend}/posts/${postId}`,
      signal,
    })
    return normalizePost(extractPost(raw, `post ${postId}`))
  }

  /** Create (id ≤ 0) or update (id > 0) one post. */
  async savePost(post: CnbPost, signal?: AbortSignal): Promise<PostUpdatedResp> {
    const raw = await this.json<unknown>({
      method: 'POST',
      url: `${this.config.blogBackend}/posts`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(post),
      signal,
    })
    const source = (raw ?? {}) as Record<string, unknown>
    const id = typeof source.id === 'number' ? source.id : -1
    if (id <= 0) {
      throw new CnbError('cnblogs accepted the post but returned no id', 200, clip(JSON.stringify(raw)))
    }
    return {
      id,
      url: normalizeUrl(typeof source.url === 'string' ? source.url : ''),
      title: typeof source.title === 'string' ? source.title : post.title,
      ...(typeof source.blogUrl === 'string' ? { blogUrl: normalizeUrl(source.blogUrl) } : {}),
      ...(typeof source.entryName === 'string' ? { entryName: source.entryName } : {}),
      ...(Array.isArray(source.tags) ? { tags: source.tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
      ...(typeof source.dateAdded === 'string' ? { dateAdded: source.dateAdded } : {}),
      ...(typeof source.postType === 'number' ? { postType: source.postType } : {}),
    }
  }

  /** Delete one post. */
  async deletePost(postId: number, signal?: AbortSignal): Promise<void> {
    await this.request({ method: 'DELETE', url: `${this.config.blogBackend}/posts/${postId}`, signal })
  }

  // --- taxonomy ------------------------------------------------------------

  /** All categories (可能为树). */
  async listCategories(signal?: AbortSignal): Promise<CategoryNode[]> {
    const raw = await this.json<unknown>({
      method: 'GET',
      url: `${this.config.blogBackend}/v2/blog-category-types/1/categories`,
      signal,
    })
    return normalizeCategories(raw)
  }

  /** Create one category. */
  async createCategory(input: { title: string; visible?: boolean; description?: string }, signal?: AbortSignal): Promise<void> {
    const body = JSON.stringify({
      title: input.title,
      visible: input.visible !== false,
      description: input.description ?? '',
    })
    await this.request({
      method: 'POST',
      url: `${this.config.blogBackend}/category/blog/1`,
      headers: { 'content-type': 'application/json' },
      body,
      signal,
    })
  }

  /** Delete one category; the backend exposes a single-id endpoint only. */
  async deleteCategory(categoryId: number, signal?: AbortSignal): Promise<void> {
    await this.request({ method: 'DELETE', url: `${this.config.blogBackend}/category/blog/${categoryId}`, signal })
  }

  /** Every tag the account has used. */
  async listTags(signal?: AbortSignal): Promise<Tag[]> {
    const raw = await this.json<unknown>({ method: 'GET', url: `${this.config.blogBackend}/tags/list`, signal })
    const list = Array.isArray(raw) ? raw : []
    return list.map((item) => {
      const source = (item ?? {}) as Record<string, unknown>
      return {
        id: typeof source.id === 'number' ? source.id : -1,
        name: typeof source.name === 'string' ? source.name : '',
      }
    }).filter((tag) => tag.name.length > 0)
  }

  // --- images --------------------------------------------------------------

  /** Upload one image and return its public URL. */
  async uploadImage(bytes: Uint8Array, mime: string, filename: string, signal?: AbortSignal): Promise<string> {
    const form = new FormData()
    // Copy into a fresh ArrayBuffer: the DOM BlobPart type rejects a view over a
    // possibly-shared buffer, and Node's FormData follows the DOM signature.
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    form.append('image', new Blob([copy.buffer], { type: mime }), filename)
    const { text } = await this.request({
      method: 'POST',
      url: `${this.config.blogBackend}/posts/body/images`,
      body: form,
      signal,
    })
    const url = text.trim().replace(/^"|"$/g, '')
    if (!/^https?:\/\//i.test(url) && !url.startsWith('//')) {
      throw new CnbError('image upload returned no URL', 200, clip(text))
    }
    return normalizeUrl(url)
  }

  /** Download an image with a size ceiling, so a huge file never reaches the blog. */
  async downloadImage(url: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('request deadline exceeded')), this.config.timeoutMs)
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    try {
      const response = await this.fetchFn(url, { method: 'GET', signal: combined, redirect: 'follow' })
      if (!response.ok) {
        throw new CnbError(`downloading ${describeUrl(url)} failed with HTTP ${response.status}`, response.status, '')
      }
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`remote image is ${declared} bytes, above maxUploadBytes`)
      }
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > maxBytes) throw new Error(`remote image is ${buffer.byteLength} bytes, above maxUploadBytes`)
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
      return { bytes: new Uint8Array(buffer), mime: contentType.startsWith('image/') ? contentType : 'image/png' }
    } finally {
      clearTimeout(timer)
    }
  }

  // --- 闪存 ----------------------------------------------------------------

  /** One page of 闪存, filtered by the backend's `@type` segment. */
  async listIngs(input: { type: number; page?: number; pageSize?: number; signal?: AbortSignal }): Promise<IngItem[]> {
    const params = new URLSearchParams({
      pageIndex: String(input.page ?? 1),
      pageSize: String(input.pageSize ?? 20),
    })
    const raw = await this.json<unknown>({
      method: 'GET',
      url: `${this.config.openapi}/statuses/@${input.type}?${params.toString()}`,
      signal: input.signal,
    })
    const list = Array.isArray(raw) ? raw : []
    return list.map((item) => normalizeIng(item))
  }

  /** Publish one 闪存. `clientType: 9` is the desktop-tool marker the extension uses. */
  async publishIng(content: string, isPrivate: boolean, signal?: AbortSignal): Promise<void> {
    await this.request({
      method: 'POST',
      url: `${this.config.openapi}/statuses`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, isPrivate, clientType: 9 }),
      signal,
    })
  }

  /** Comment on a 闪存. */
  async commentIng(ingId: number, content: string, signal?: AbortSignal): Promise<void> {
    await this.request({
      method: 'POST',
      url: `${this.config.openapi}/statuses/${ingId}/comments`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      signal,
    })
  }
}

/** Both post reads wrap the post in `blogPost`; tolerate a bare post too. */
export function extractPost(raw: unknown, label: string): unknown {
  if (raw === null || typeof raw !== 'object') {
    throw new CnbError(`cnblogs returned no ${label}`, 200, '')
  }
  const source = raw as Record<string, unknown>
  const post = source.blogPost ?? source.post
  if (post === undefined || post === null || typeof post !== 'object') {
    throw new CnbError(`cnblogs returned no ${label}`, 200, clip(JSON.stringify(raw)))
  }
  return post
}
