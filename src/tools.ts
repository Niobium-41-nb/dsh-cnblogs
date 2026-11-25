/**
 * The eight model-callable cnblogs tools.
 *
 * Every tool resolves a token, builds a request, and reports the backend's own
 * answer. Failures come back as an `ok: false` result with the server's message
 * instead of a thrown error, so one bad call does not end the turn.
 * @module dsh-cnblogs/tools
 */

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { CnbApi, flattenCategories } from './api.ts'
import type { FetchLike } from './api.ts'
import type { AuthStore } from './auth.ts'
import { assertTokenShape } from './config.ts'
import { extensionForMime, parseDataUrl } from './images.ts'
import {
  deletePosts, getPostDetail, listPosts, savePost,
} from './posts.ts'
import type { SaveInput } from './posts.ts'
import type { StateStore } from './store.ts'
import type { Config } from './types.ts'

/** Registration inputs; `fetchFn` is the test seam. */
export interface ToolsOptions {
  config: Config
  store: StateStore
  auth: AuthStore
  fetchFn?: FetchLike
}

interface AccountResult {
  ok: boolean
  action: string
  authed: boolean
  source: string
  displayName: string
  blogApp: string
  blogId: number
  message: string
}

interface PostRow {
  id: number
  title: string
  state: string
  url: string
  datePublished: string
  dateUpdated: string
  viewCount: number
  entryName: string
}

interface ListPostsResult {
  ok: boolean
  postsCount: number
  pageCount: number
  pageIndex: number
  pageSize: number
  posts: PostRow[]
  message: string
}

interface GetPostResult {
  ok: boolean
  postId: number
  title: string
  url: string
  state: string
  access: string
  isMarkdown: boolean
  entryName: string
  tags: string[]
  categoryIds: number[]
  datePublished: string
  dateUpdated: string
  body: string
  bodyChars: number
  bodyTruncated: boolean
  message: string
}

interface SavePostResult {
  ok: boolean
  action: string
  postId: number
  url: string
  title: string
  state: string
  access: string
  tags: string[]
  categoryIds: number[]
  imagesUploaded: number
  imagesFailed: string[]
  verified: string
  bodyChars: number
  warnings: string[]
  message: string
}

interface DeletePostsResult {
  ok: boolean
  deleted: number[]
  failed: string[]
  message: string
}

interface UploadImageResult {
  ok: boolean
  url: string
  source: string
  bytes: number
  message: string
}

interface TaxonomyResult {
  ok: boolean
  action: string
  categories: string[]
  tags: string[]
  message: string
}

interface IngsResult {
  ok: boolean
  action: string
  ings: string[]
  message: string
}

/** Human-readable failure text. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The 闪存 type segments the backend exposes. */
const ING_TYPES: Record<string, number> = { all: 5, mine: 4, following: 1 }

/** Register every tool on the host context. */
export function registerTools(ctx: Context, options: ToolsOptions): void {
  const { config, store, auth } = options

  /** Resolve the token and build a client, or throw a message that says where to put one. */
  const client = async (): Promise<{ api: CnbApi; source: string }> => {
    const resolved = await auth.resolve()
    if (resolved === undefined) {
      throw new Error(
        'no cnblogs token configured: set CNBLOGS_PAT, or write the personal access token to '
        + `${auth.tokenPath()} (create one at https://account.cnblogs.com/settings/tokens)`,
      )
    }
    return { api: new CnbApi(config, resolved.token, options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }), source: resolved.source }
  }

  if (config.enabled === false) return

  ctx.tools.register(defineTool({
    name: 'cnblogs_account',
    description: 'Check which cnblogs account the configured token belongs to, store a personal access token, or '
      + 'forget it. Call `status` before publishing so a wrong or expired token is diagnosed before a post is written.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'save', 'clear'],
        description: '`status` verifies the current token; `save` stores a new one after verifying it; `clear` removes it.',
      },
      token: {
        type: 'string',
        description: 'Personal access token to store. Only pass one the user gave you in this conversation: a token in '
          + 'a tool argument is recorded in the session log. Prefer `CNBLOGS_PAT` or the token file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          authed: { type: 'boolean', required: true },
          source: { type: 'string', required: true },
          displayName: { type: 'string', required: true },
          blogApp: { type: 'string', required: true },
          blogId: { type: 'integer', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as AccountResult).message }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { action: string; token?: string }): Promise<AccountResult> {
      const base: AccountResult = {
        ok: false, action: args.action, authed: false, source: '', displayName: '', blogApp: '', blogId: 0, message: '',
      }
      try {
        if (args.action === 'clear') {
          const cleared = await auth.clear()
          const lines: string[] = []
          if (cleared.credential) lines.push('removed the stored credential record')
          if (cleared.tokenFile) {
            lines.push(cleared.hadToken
              ? `removed ${auth.tokenPath()}`
              : `removed the empty token template at ${auth.tokenPath()}; a new template appears on the next start`)
          }
          if (lines.length === 0) lines.push('nothing was stored')
          return { ...base, ok: true, message: lines.join('\n') }
        }

        if (args.action === 'save') {
          if (args.token === undefined || args.token.trim().length === 0) {
            return { ...base, message: 'action "save" needs a `token` argument' }
          }
          const token = assertTokenShape(args.token)
          const probe = new CnbApi(config, token, options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn })
          const account = await probe.getAccount()
          const source = await auth.save(token)
          store.setAccount(account)
          return {
            ...base,
            ok: true,
            authed: true,
            source,
            displayName: account.displayName,
            blogApp: account.blogApp,
            blogId: account.blogId,
            message: [
              `token verified and stored (${source})`,
              `account: ${account.displayName} — https://www.cnblogs.com/${account.blogApp}`,
              `blog id: ${account.blogId}`,
            ].join('\n'),
          }
        }

        const resolved = await auth.resolve()
        if (resolved === undefined) {
          return {
            ...base,
            ok: true,
            message: [
              'no cnblogs token configured.',
              'Create a personal access token at https://account.cnblogs.com/settings/tokens, then either:',
              '  - set CNBLOGS_PAT in the environment of the harness process, or',
              `  - write it (one line) to ${auth.tokenPath()}`,
              '`cnblogs_account` with action `save` works too, but the token then appears in this conversation.',
            ].join('\n'),
          }
        }
        const api = new CnbApi(config, resolved.token, options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn })
        const account = await api.getAccount()
        store.setAccount(account)
        const stored = store.read().account
        return {
          ...base,
          ok: true,
          authed: true,
          source: resolved.source,
          displayName: account.displayName,
          blogApp: account.blogApp,
          blogId: account.blogId,
          message: [
            `token source: ${resolved.source}`,
            `account: ${account.displayName} (blog ${account.blogApp}, id ${account.blogId})`,
            stored === undefined ? 'account not cached yet' : `last verified: ${stored.checkedAt}`,
          ].join('\n'),
        }
      } catch (error) {
        return { ...base, message: `cnblogs_account ${args.action} failed: ${describeError(error)}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cnblogs_list_posts',
    description: 'List the account\'s blog posts, newest first, with ids and publication state. Use it to find a post '
      + 'id, check what is already published, or search titles.',
    parameters: {
      page: { type: 'integer', description: '1-based page number. Default 1.' },
      pageSize: { type: 'integer', description: 'Posts per page (1-100). Default 20.' },
      search: { type: 'string', description: 'Title or full-text keyword filter.' },
      categoryId: { type: 'integer', description: 'Only posts in this category id (see cnblogs_taxonomy).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          postsCount: { type: 'integer', required: true },
          pageCount: { type: 'integer', required: true },
          pageIndex: { type: 'integer', required: true },
          pageSize: { type: 'integer', required: true },
          posts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                title: { type: 'string', required: true },
                state: { type: 'string', required: true },
                url: { type: 'string', required: true },
                datePublished: { type: 'string', required: true },
                dateUpdated: { type: 'string', required: true },
                viewCount: { type: 'integer', required: true },
                entryName: { type: 'string', required: true },
              },
            },
          },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as ListPostsResult).message }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { page?: number; pageSize?: number; search?: string; categoryId?: number }, exec: ToolRunContext): Promise<ListPostsResult> {
      const empty: ListPostsResult = {
        ok: false, postsCount: 0, pageCount: 0, pageIndex: args.page ?? 1, pageSize: args.pageSize ?? 20, posts: [], message: '',
      }
      try {
        const { api } = await client()
        const page = await listPosts(api, {
          ...(args.page === undefined ? {} : { page: args.page }),
          pageSize: Math.min(Math.max(args.pageSize ?? 20, 1), 100),
          ...(args.search === undefined ? {} : { search: args.search }),
          ...(args.categoryId === undefined ? {} : { categoryId: args.categoryId }),
          signal: exec.signal,
        })
        const rows: PostRow[] = page.posts.map((item) => ({
          id: item.id,
          title: item.title,
          state: item.isPublished ? 'published' : item.isDraft ? 'draft' : 'unpublished',
          url: item.url,
          datePublished: item.datePublished,
          dateUpdated: item.dateUpdated,
          viewCount: item.viewCount,
          entryName: item.entryName,
        }))
        const lines = rows.map((row) => `- #${row.id} [${row.state}] ${row.datePublished.slice(0, 10)} ${row.title}`
          + `${row.viewCount > 0 ? ` (${row.viewCount} views)` : ''}`)
        return {
          ok: true,
          postsCount: page.postsCount,
          pageCount: page.pageCount,
          pageIndex: page.pageIndex,
          pageSize: page.pageSize,
          posts: rows,
          message: [
            `${page.postsCount} posts, page ${page.pageIndex}/${page.pageCount}`,
            ...(lines.length > 0 ? lines : ['(no posts on this page)']),
          ].join('\n'),
        }
      } catch (error) {
        return { ...empty, message: `cnblogs_list_posts failed: ${describeError(error)}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cnblogs_get_post',
    description: 'Read one stored post as markdown, with its tags, categories, publication state and URL. Use it to '
      + 'edit a post, to check what the blog actually stored, or to pull a post to a local file.',
    parameters: {
      postId: { type: 'integer', required: true, description: 'The post id from cnblogs_list_posts.' },
      maxBodyChars: { type: 'integer', description: 'Truncate the returned markdown after this many characters. Default 20000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          postId: { type: 'integer', required: true },
          title: { type: 'string', required: true },
          url: { type: 'string', required: true },
          state: { type: 'string', required: true },
          access: { type: 'string', required: true },
          isMarkdown: { type: 'boolean', required: true },
          entryName: { type: 'string', required: true },
          tags: { type: 'array', items: { type: 'string' }, required: true },
          categoryIds: { type: 'array', items: { type: 'integer' }, required: true },
          datePublished: { type: 'string', required: true },
          dateUpdated: { type: 'string', required: true },
          body: { type: 'string', required: true },
          bodyChars: { type: 'integer', required: true },
          bodyTruncated: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as GetPostResult).message }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { postId: number; maxBodyChars?: number }, exec: ToolRunContext): Promise<GetPostResult> {
      const empty: GetPostResult = {
        ok: false, postId: args.postId, title: '', url: '', state: '', access: '', isMarkdown: true, entryName: '',
        tags: [], categoryIds: [], datePublished: '', dateUpdated: '', body: '', bodyChars: 0, bodyTruncated: false, message: '',
      }
      try {
        const { api } = await client()
        const detail = await getPostDetail(api, args.postId, Math.max(args.maxBodyChars ?? 20_000, 1), exec.signal)
        const header = [
          `#${detail.postId} ${detail.title}`,
          `${detail.state} · ${detail.access} · ${detail.tags.length} tags · categories: ${detail.categoryIds.join(', ') || '(none)'}`,
          `published ${detail.datePublished.slice(0, 19)} · updated ${detail.dateUpdated.slice(0, 19)}`,
          detail.url,
          detail.bodyTruncated ? `--- body truncated at ${detail.body.length} of ${detail.bodyChars} characters ---` : '',
        ].filter((line) => line.length > 0).join('\n')
        return {
          ok: true,
          ...detail,
          tags: detail.tags,
          categoryIds: detail.categoryIds,
          message: `${header}\n\n${detail.body}`,
        }
      } catch (error) {
        return { ...empty, message: `cnblogs_get_post failed: ${describeError(error)}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cnblogs_save_post',
    description: 'Create or update a blog post from a markdown file or inline text. With `file`, the post id recorded for '
      + 'that file is reused, so the second save updates instead of creating a duplicate. The body is read back after '
      + 'saving and the result says whether the blog stored it. New posts are created as drafts unless `status` is `publish`.',
    parameters: {
      file: { type: 'string', description: 'Local markdown file. Relative image paths resolve against its directory.' },
      body: { type: 'string', description: 'Inline markdown; ignored when `file` is set.' },
      title: { type: 'string', description: 'Post title; otherwise front matter `title:`, otherwise the file name.' },
      postId: { type: 'integer', description: 'Update this post id. Otherwise the id recorded for `file`, or a new post.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replaces the tag list.' },
      categories: { type: 'array', items: { type: 'string' }, description: 'Category names or numeric ids; replaces the list.' },
      status: { type: 'string', enum: ['draft', 'publish'], description: 'Publication state. Defaults to `draft` for a new post.' },
      access: {
        type: 'string',
        enum: ['public', 'login', 'owner'],
        description: 'Who may read it: everyone, signed-in users, or only the owner. Default `public`.',
      },
      slug: { type: 'string', description: 'URL slug (`entryName`).' },
      summary: { type: 'string', description: 'Post summary shown in lists and feeds.' },
      pinned: { type: 'boolean', description: 'Pin the post at the top of the blog.' },
      comments: { type: 'boolean', description: 'Allow comments.' },
      extractImages: {
        type: 'boolean',
        description: 'Upload local and data-URL images to the blog and rewrite the links. Defaults to the plugin setting.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          postId: { type: 'integer', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          state: { type: 'string', required: true },
          access: { type: 'string', required: true },
          tags: { type: 'array', items: { type: 'string' }, required: true },
          categoryIds: { type: 'array', items: { type: 'integer' }, required: true },
          imagesUploaded: { type: 'integer', required: true },
          imagesFailed: { type: 'array', items: { type: 'string' }, required: true },
          verified: { type: 'string', required: true },
          bodyChars: { type: 'integer', required: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as SavePostResult).message }],
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `Cnblogs publish ${(args as SaveInput).title ?? (args as SaveInput).file ?? 'inline markdown'}`,
      kind: 'edit' as const,
    }),
    async execute(args: SaveInput, exec: ToolRunContext): Promise<SavePostResult> {
      const empty: SavePostResult = {
        ok: false, action: 'none', postId: 0, url: '', title: '', state: '', access: '', tags: [], categoryIds: [],
        imagesUploaded: 0, imagesFailed: [], verified: 'unchecked', bodyChars: 0, warnings: [], message: '',
      }
      try {
        if ((args.file === undefined || args.file.trim().length === 0) && (args.body === undefined || args.body.trim().length === 0)) {
          return { ...empty, message: 'cnblogs_save_post needs `file` or `body`' }
        }
        const { api } = await client()
        const result = await savePost({
          api,
          store,
          config,
          input: args,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
        const lines = [
          `${result.action} post #${result.postId}: ${result.title}`,
          `${result.state} · ${result.access} · ${result.bodyChars} characters · verified: ${result.verified}`,
          result.url.length > 0 ? result.url : '(the backend returned no public URL)',
          result.categoryIds.length > 0 ? `categories: ${result.categoryIds.join(', ')}` : '',
          result.tags.length > 0 ? `tags: ${result.tags.join(', ')}` : '',
          result.imagesUploaded > 0 ? `images uploaded: ${result.imagesUploaded}` : '',
          ...result.warnings.map((warning) => `warning: ${warning}`),
        ].filter((line) => line.length > 0)
        return { ...empty, ok: true, ...result, message: lines.join('\n') }
      } catch (error) {
        return { ...empty, message: `cnblogs_save_post failed: ${describeError(error)}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cnblogs_delete_posts',
    description: 'Delete one or more blog posts. This removes them from the blog permanently; there is no draft state '
      + 'to fall back to.',
    parameters: {
      postIds: {
        type: 'array',
        items: { type: 'integer' },
        required: true,
        description: 'Post ids to delete, from cnblogs_list_posts.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          deleted: { type: 'array', items: { type: 'integer' }, required: true },
          failed: { type: 'array', items: { type: 'string' }, required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as DeletePostsResult).message }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { postIds: number[] }, exec: ToolRunContext): Promise<DeletePostsResult> {
      const empty: DeletePostsResult = { ok: false, deleted: [], failed: [], message: '' }
      try {
        if (args.postIds.length === 0) return { ...empty, message: 'cnblogs_delete_posts needs at least one post id' }
        const { api } = await client()
        const result = await deletePosts(api, args.postIds, exec.signal)
        const failures = result.failed.map((item) => `#${item.id}: ${item.error}`)
        return {
          ok: result.failed.length === 0,
          deleted: result.deleted,
          failed: failures,
          message: [
            `deleted: ${result.deleted.length > 0 ? result.deleted.map((id) => `#${id}`).join(', ') : '(none)'}`,
            ...(failures.length > 0 ? ['not deleted:', ...failures.map((line) => `- ${line}`)] : []),
          ].join('\n'),
        }
      } catch (error) {
        return { ...empty, message: `cnblogs_delete_posts failed: ${describeError(error)}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cnblogs_upload_image',
    description: 'Upload one image to the blog image store and get its URL, ready to embed in markdown. Saving a post '
      + 'already rehosts referenced images, so use this only when the URL itself is needed.',
    parameters: {
      path: { type: 'string', description: 'Local image file. `~` is expanded.' },
      url: { type: 'string', description: 'Remote image URL to download and rehost.' },
      dataUrl: { type: 'string', description: 'A base64 `data:image/...` URL.' },
      mime: { type: 'string', description: 'Content type override, e.g. `image/png`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          source: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as UploadImageResult).message }],
    },
    isConcurrencySafe: () => true,
    async execute(
      args: { path?: string; url?: string; dataUrl?: string; mime?: string },
      exec: ToolRunContext,
    ): Promise<UploadImageResult> {
      const empty: UploadImageResult = { ok: false, url: '', source: '', bytes: 0, message: '' }
      try {
        const given = [args.path, args.url, args.dataUrl].filter((value) => value !== undefined && value.trim().length > 0)
        if (given.length !== 1) return { ...empty, message: 'pass exactly one of `path`, `url` or `dataUrl`' }
        const { api } = await client()

        let bytes: Uint8Array
        let mime = args.mime ?? ''
        let filename = 'image.png'
        let source = ''
        if (args.path !== undefined) {
          const path = args.path.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE ?? process.env.HOME ?? '~')
          if (mime.length === 0) {
            const ext = extname(path).toLowerCase().replace('.', '')
            mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext.length > 0 ? ext : 'png'}`
          }
          bytes = readFileSync(path)
          filename = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) || filename
          source = path
        } else if (args.url !== undefined) {
          const downloaded = await api.downloadImage(args.url, config.maxUploadBytes, exec.signal)
          bytes = downloaded.bytes
          if (mime.length === 0) mime = downloaded.mime
          source = args.url
        } else {
          const parsed = parseDataUrl(args.dataUrl ?? '')
          if (parsed === undefined) return { ...empty, message: '`dataUrl` is not a base64 image data URL' }
          bytes = parsed.bytes
          if (mime.length === 0) mime = parsed.mime
          filename = `image.${extensionForMime(mime)}`
          source = 'data URL'
        }

        if (bytes.byteLength > config.maxUploadBytes) {
          return { ...empty, message: `image is ${bytes.byteLength} bytes, above maxUploadBytes (${config.maxUploadBytes})` }
        }
        if (mime.length === 0) mime = 'image/png'
        const url = await api.uploadImage(bytes, mime, filename, exec.signal)
        return {
          ok: true,
          url,
          source,
          bytes: bytes.byteLength,
          message: `uploaded ${bytes.byteLength} bytes (${mime}) from ${source}\n${url}`,
        }
      } catch (error) {
        return { ...empty, message: `cnblogs_upload_image failed: ${describeError(error)}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cnblogs_taxonomy',
    description: 'Inspect or change the blog taxonomy: list categories (with ids and post counts), list tags, create a '
      + 'category, or delete categories. `cnblogs_save_post` accepts either category names or these ids.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list-categories', 'list-tags', 'create-category', 'delete-category'],
      },
      title: { type: 'string', description: 'Title for `create-category`.' },
      description: { type: 'string', description: 'Description for `create-category`.' },
      visible: { type: 'boolean', description: 'Whether a new category is visible on the blog. Default true.' },
      categoryIds: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Ids to delete with `delete-category`.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          categories: { type: 'array', items: { type: 'string' }, required: true },
          tags: { type: 'array', items: { type: 'string' }, required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as TaxonomyResult).message }],
    },
    isConcurrencySafe: () => false,
    async execute(
      args: { action: string; title?: string; description?: string; visible?: boolean; categoryIds?: number[] },
      exec: ToolRunContext,
    ): Promise<TaxonomyResult> {
      const empty: TaxonomyResult = { ok: false, action: args.action, categories: [], tags: [], message: '' }
      try {
        const { api } = await client()
        if (args.action === 'list-tags') {
          const tags = await api.listTags(exec.signal)
          return {
            ...empty,
            ok: true,
            tags: tags.map((tag) => tag.name),
            message: tags.length === 0 ? 'no tags yet' : `${tags.length} tags\n${tags.map((tag) => `- ${tag.name}`).join('\n')}`,
          }
        }

        if (args.action === 'create-category') {
          const title = (args.title ?? '').trim()
          if (title.length === 0) return { ...empty, message: 'action "create-category" needs a `title`' }
          await api.createCategory({
            title,
            ...(args.visible === undefined ? {} : { visible: args.visible }),
            ...(args.description === undefined ? {} : { description: args.description }),
          }, exec.signal)
          const categories = flattenCategories(await api.listCategories(exec.signal))
          return {
            ...empty,
            ok: true,
            categories: categories.map((node) => `${node.categoryId}: ${node.title}`),
            message: `created category "${title}"\n${categories.map((node) => `- ${node.categoryId}: ${node.title} (${node.itemCount})`).join('\n')}`,
          }
        }

        if (args.action === 'delete-category') {
          const ids = args.categoryIds ?? []
          if (ids.length === 0) return { ...empty, message: 'action "delete-category" needs `categoryIds`' }
          const failed: string[] = []
          for (const id of ids) {
            try {
              await api.deleteCategory(id, exec.signal)
            } catch (error) {
              failed.push(`${id}: ${describeError(error)}`)
            }
          }
          const categories = flattenCategories(await api.listCategories(exec.signal))
          return {
            ...empty,
            ok: failed.length === 0,
            categories: categories.map((node) => `${node.categoryId}: ${node.title}`),
            message: [
              `deleted ${ids.length - failed.length} of ${ids.length} categories`,
              ...(failed.length > 0 ? ['not deleted:', ...failed.map((line) => `- ${line}`)] : []),
            ].join('\n'),
          }
        }

        const categories = flattenCategories(await api.listCategories(exec.signal))
        return {
          ...empty,
          ok: true,
          categories: categories.map((node) => `${node.categoryId}: ${node.title}`),
          message: categories.length === 0
            ? 'no categories yet'
            : `${categories.length} categories\n${categories.map((node) => `- ${node.categoryId}: ${node.title} (${node.itemCount} posts)`).join('\n')}`,
        }
      } catch (error) {
        return { ...empty, message: `cnblogs_taxonomy ${args.action} failed: ${describeError(error)}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cnblogs_ings',
    description: 'Read, post or comment on 闪存 (cnblogs short statuses). Publishing a 闪存 is public by default and '
      + 'cannot be edited afterwards, so treat it like a tweet.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'publish', 'comment'],
        description: '`list` reads a page of 闪存; `publish` posts one; `comment` replies to one.',
      },
      type: {
        type: 'string',
        enum: ['mine', 'all', 'following'],
        description: 'Which feed `list` reads. Default `mine`.',
      },
      page: { type: 'integer', description: '1-based page for `list`. Default 1.' },
      pageSize: { type: 'integer', description: 'Items per page for `list` (1-50). Default 20.' },
      content: { type: 'string', description: 'Text for `publish` or `comment`.' },
      isPrivate: { type: 'boolean', description: 'Make a published 闪存 private. Default false.' },
      ingId: { type: 'integer', description: 'The 闪存 id for `comment`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          ings: { type: 'array', items: { type: 'string' }, required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as IngsResult).message }],
    },
    isConcurrencySafe: () => false,
    async execute(
      args: { action: string; type?: string; page?: number; pageSize?: number; content?: string; isPrivate?: boolean; ingId?: number },
      exec: ToolRunContext,
    ): Promise<IngsResult> {
      const empty: IngsResult = { ok: false, action: args.action, ings: [], message: '' }
      try {
        const { api } = await client()
        if (args.action === 'publish') {
          const content = (args.content ?? '').trim()
          if (content.length === 0) return { ...empty, message: 'action "publish" needs `content`' }
          await api.publishIng(content, args.isPrivate === true, exec.signal)
          return {
            ...empty,
            ok: true,
            message: `published a 闪存 (${content.length} characters${args.isPrivate === true ? ', private' : ', public'})`,
          }
        }
        if (args.action === 'comment') {
          const content = (args.content ?? '').trim()
          if (args.ingId === undefined) return { ...empty, message: 'action "comment" needs `ingId`' }
          if (content.length === 0) return { ...empty, message: 'action "comment" needs `content`' }
          await api.commentIng(args.ingId, content, exec.signal)
          return { ...empty, ok: true, message: `commented on 闪存 #${args.ingId}` }
        }
        const type = ING_TYPES[args.type ?? 'mine'] ?? ING_TYPES.mine
        const items = await api.listIngs({
          type: type as number,
          page: args.page ?? 1,
          pageSize: Math.min(Math.max(args.pageSize ?? 20, 1), 50),
          signal: exec.signal,
        })
        const lines = items.map((item) => {
          const excerpt = item.content.replace(/\s+/g, ' ').trim().slice(0, 200)
          const author = item.userAlias.length > 0 ? item.userAlias : item.userDisplayName
          return `- #${item.id} ${item.dateAdded.slice(0, 16)} ${author}${item.isPrivate ? ' [private]' : ''}: ${excerpt}`
        })
        return {
          ...empty,
          ok: true,
          ings: lines,
          message: lines.length === 0 ? 'no 闪存 on this page' : `${items.length} 闪存\n${lines.join('\n')}`,
        }
      } catch (error) {
        return { ...empty, message: `cnblogs_ings ${args.action} failed: ${describeError(error)}` }
      }
    },
  }))
}
