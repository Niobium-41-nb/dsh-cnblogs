/**
 * Domain types shared by the API client, the post orchestration layer, and the
 * model-facing tools. Everything here is plain data: no classes, no behavior, so
 * a type can be sent to the model or asserted in a test without importing the
 * rest of the plugin.
 * @module dsh-cnblogs/types
 */

/** Where a new post lands: a draft is invisible to readers until published. */
export type PostStatus = 'draft' | 'publish'

/** Who may read a post, in the backend's own vocabulary. */
export type AccessLevel = 'public' | 'login' | 'owner'

/** The observed state of an existing post, derived from `isDraft`/`isPublished`. */
export type PostState = 'draft' | 'published' | 'unpublished'

/** `accessPermission` bit values used by the cnblogs backend. */
export const ACCESS_PERMISSION: Record<AccessLevel, number> = {
  public: 0,
  login: 1 << 3,
  owner: 1 << 28,
}

/** Post type: 1 = 随笔 (blog post), 2 = 文章 (article). */
export const POST_TYPE_BLOG_POST = 1
export const POST_TYPE_ARTICLE = 2

/** Plugin configuration after defaults are applied. */
export interface Config {
  /** Mount the tool set at all. */
  enabled: boolean
  /** Personal access token given inline. Prefer `tokenFile`, a credential record, or the environment. */
  token: string
  /** File holding one PAT. Defaults to `<stateDir>/token`. */
  tokenFile: string
  /** Plugin state directory. Defaults to `<DSH_HOME>/dsh-cnblogs`. */
  stateDir: string
  /** Blog backend base URL (`/posts`, `/posts/list`, `/posts/body/images`, ...). */
  blogBackend: string
  /** Open API base URL (`/users`, `/statuses`, ...). */
  openapi: string
  /** Per-request deadline in milliseconds. */
  timeoutMs: number
  /** Largest post body accepted from a file or tool argument. */
  maxBodyChars: number
  /** Largest single image accepted for upload or rehosting. */
  maxUploadBytes: number
  /** Rehost local and data-URL images referenced by a published post. */
  extractImages: boolean
  /** Also rehost third-party HTTP images (never images already on cnblogs). */
  extractWebImages: boolean
  /** Keep a YAML front matter block in the uploaded markdown. */
  keepFrontMatter: boolean
  /** Status applied to a newly created post when the caller does not say. */
  defaultStatus: PostStatus
  /** Access level applied to a newly created post when the caller does not say. */
  defaultAccess: AccessLevel
  /** Add the short usage section to the system prompt. */
  promptSection: boolean
}

/** One row of `GET /posts/list`. */
export interface PostListItem {
  id: number
  title: string
  url: string
  entryName: string
  isDraft: boolean
  isPublished: boolean
  isMarkdown: boolean
  postType: number
  accessPermission: number
  datePublished: string
  dateUpdated: string
  viewCount: number
}

/** `GET /posts/list` response. */
export interface PostListModel {
  postsCount: number
  pageIndex: number
  pageSize: number
  postList: PostListItem[]
}

/** The a post as the backend stores it. Unknown fields are preserved on write. */
export interface CnbPost {
  id: number
  title: string
  postBody: string
  isMarkdown: boolean
  isDraft: boolean
  isPublished: boolean
  postType: number
  accessPermission: number
  categoryIds: number[]
  tags: string[]
  entryName: string
  description: string
  isAllowComments: boolean
  isPinned: boolean
  displayOnHomePage: boolean
  password?: string | null
  datePublished?: string
  [key: string]: unknown
}

/** `POST /posts` response. */
export interface PostUpdatedResp {
  id: number
  url: string
  blogUrl?: string
  title: string
  entryName?: string
  tags?: string[]
  dateAdded?: string
  postType?: number
}

/** A category row, possibly nested through `children`. */
export interface CategoryNode {
  categoryId: number
  title: string
  parentId: number | null
  visible: boolean
  description: string
  itemCount: number
  children?: CategoryNode[] | null
}

/** A tag row from `GET /tags/list`. */
export interface Tag {
  id: number
  name: string
}

/** `GET /users` projects PascalCase fields; this is the normalized view. */
export interface Account {
  userId: string
  spaceUserId: number
  blogId: number
  displayName: string
  blogApp: string
  avatar: string
  isVip: boolean
  joined: string
}

/** One 闪存 (status) row. */
export interface IngItem {
  id: number
  content: string
  isPrivate: boolean
  dateAdded: string
  commentCount: number
  userDisplayName: string
  userAlias: string
}

/** File → post association kept in the plugin state directory. */
export interface FileMapping {
  postId: number
  url: string
  title: string
  updatedAt: string
}

/** Whole state document. */
export interface StateDocument {
  version: 1
  files: Record<string, FileMapping>
  account?: {
    displayName: string
    blogApp: string
    blogId: number
    checkedAt: string
  }
}
