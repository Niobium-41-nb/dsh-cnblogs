/**
 * Wiring tests: mount the plugin against a fake Cordis context and a fake
 * cnblogs backend, then drive all eight tools — including a full publish cycle
 * with image rehosting, an update through the file mapping, and failure paths.
 *
 * Run: node --experimental-strip-types tests/plugin.test.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { apply } from '../src/index.ts'

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

function equal(label, actual, expected) {
  const actualText = typeof actual === 'string' ? actual : JSON.stringify(actual)
  const expectedText = typeof expected === 'string' ? expected : JSON.stringify(expected)
  ok(label, actualText === expectedText, `expected ${expectedText}, got ${actualText}`)
}

// The environment must not influence token resolution.
process.env.CNBLOGS_PAT = ''
process.env.CNBLOGS_TOKEN = ''

const BASE = 'https://cnb.test/api'
const TOKEN = 'a'.repeat(64)

const TEMPLATE = {
  id: -1,
  author: 'alice',
  title: '',
  postBody: '',
  isMarkdown: true,
  isDraft: true,
  isPublished: false,
  postType: 1,
  accessPermission: 0,
  categoryIds: [],
  tags: [],
  entryName: '',
  description: '',
  isAllowComments: true,
  isPinned: false,
  displayOnHomePage: true,
  blogId: 42,
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function text(status, value) {
  return new Response(value, { status, headers: { 'content-type': 'text/plain' } })
}

/** A small in-memory cnblogs backend with the endpoints the plugin calls. */
function createBackend() {
  const calls = []
  const posts = new Map()
  const deletedCategories = []
  const state = { nextId: 100, failStatus: 0 }

  const fetchFn = async (input, init = {}) => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ url, method, headers: init.headers ?? {}, body: init.body })
    if (state.failStatus !== 0) return json(state.failStatus, { message: 'injected failure' })

    const path = url.slice(BASE.length).split('?')[0]
    const query = new URL(url, 'https://placeholder').searchParams

    if (path === '/users') {
      return json(200, {
        UserId: 'u1',
        SpaceUserID: 1,
        BlogId: 42,
        DisplayName: 'Alice',
        BlogApp: 'alice',
        Avatar: '//img.example/avatar.png',
        IsVip: false,
        Joined: '2020-01-01T00:00:00',
      })
    }

    if (path === '/posts/body/images' && method === 'POST') {
      return text(200, 'https://img2020.cnblogs.com/blog/1/uploaded.png')
    }

    if (path === '/posts/-1' && method === 'GET') {
      return json(200, { blogPost: { ...TEMPLATE }, myConfig: {} })
    }

    if (path === '/posts/list' && method === 'GET') {
      const rows = [...posts.values()].map((post) => ({
        id: post.id,
        title: post.title,
        url: `//www.cnblogs.com/alice/p/${post.id}.html`,
        entryName: post.entryName,
        isDraft: post.isDraft,
        isPublished: post.isPublished,
        isMarkdown: true,
        postType: 1,
        accessPermission: post.accessPermission,
        datePublished: '2024-05-01T10:00:00',
        dateUpdated: '2024-05-02T10:00:00',
        viewCount: 7,
      }))
      return json(200, { postsCount: rows.length, pageIndex: Number(query.get('p') ?? '1'), pageSize: Number(query.get('s') ?? '20'), postList: rows })
    }

    if (path === '/posts' && method === 'POST') {
      const incoming = JSON.parse(String(init.body))
      const creating = typeof incoming.id !== 'number' || incoming.id <= 0
      const id = creating ? state.nextId++ : incoming.id
      if (!creating && !posts.has(id)) return json(404, { message: 'post not found' })
      const stored = { ...incoming, id }
      posts.set(id, stored)
      return json(200, {
        id,
        url: `//www.cnblogs.com/alice/p/${id}.html`,
        title: stored.title,
        tags: stored.tags,
        entryName: stored.entryName,
        dateAdded: '2024-05-01T10:00:00',
        postType: 1,
      })
    }

    const single = /^\/posts\/(\d+)$/.exec(path)
    if (single !== null) {
      const id = Number(single[1])
      if (method === 'GET') {
        const post = posts.get(id)
        if (post === undefined) return json(404, { message: 'post not found' })
        return json(200, { blogPost: post, myConfig: {} })
      }
      if (method === 'DELETE') {
        if (!posts.has(id)) return json(404, { message: 'post not found' })
        posts.delete(id)
        return text(200, '')
      }
    }

    if (path === '/v2/blog-category-types/1/categories' && method === 'GET') {
      // The live endpoint wraps the list in an object; the fake must match it.
      return json(200, {
        categories: [
          { categoryId: 10, title: '后端', parentId: null, visible: true, itemCount: 2, children: [{ categoryId: 11, title: 'Rust', parentId: 10, visible: true, itemCount: 1 }] },
          { categoryId: 12, title: '前端', parentId: null, visible: true, itemCount: 0 },
        ],
        parent: null,
      })
    }

    if (path === '/category/blog/1' && method === 'POST') {
      return text(200, '')
    }

    const category = /^\/category\/blog\/(\d+)$/.exec(path)
    if (category !== null && method === 'DELETE') {
      deletedCategories.push(Number(category[1]))
      return text(200, '')
    }

    if (path === '/tags/list' && method === 'GET') {
      return json(200, [{ id: 1, name: 'rust' }, { id: 2, name: 'vscode', createTime: '2023-01-01' }])
    }

    if (path === '/statuses' && method === 'POST') {
      return text(200, '')
    }

    if (path.startsWith('/statuses/@') && method === 'GET') {
      return json(200, [
        { Id: 5, Content: 'hello world', IsPrivate: false, DateAdded: '2024-05-01T10:00:00', CommentCount: 1, UserDisplayName: 'Alice', UserAlias: 'alice' },
      ])
    }

    if (/^\/statuses\/\d+\/comments$/.test(path) && method === 'POST') {
      return text(200, '')
    }

    return json(404, { message: `no route for ${method} ${path}` })
  }

  return { fetchFn, calls, posts, deletedCategories, state }
}

/** A fake Cordis context exposing only what the plugin touches. */
function createContext() {
  const registered = new Map()
  const sections = []
  return {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
      },
    },
    inject(_services, callback) {
      callback({
        systemPrompt: {
          section(section) {
            sections.push(section)
            return () => {}
          },
        },
      })
    },
    get(name) {
      if (name === 'credentials') return undefined
      return undefined
    },
    registered,
    sections,
  }
}

function mount(overrides = {}) {
  const ctx = createContext()
  const backend = createBackend()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cnblogs-plugin-'))
  const config = resolveConfig({
    token: TOKEN,
    stateDir: dir,
    blogBackend: BASE,
    openapi: BASE,
    ...overrides,
  })
  apply(ctx, config, { fetchFn: backend.fetchFn })
  return { ctx, backend, config, dir }
}

const SIGNAL = new AbortController().signal

async function call(ctx, name, args) {
  const tool = ctx.registered.get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return await tool.execute(args, { signal: SIGNAL })
}

/** Ensure a tool result matches its declared output schema. */
function validate(schema, value, path, problems) {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${path}: expected object`)
      return
    }
    const properties = schema.properties ?? {}
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) problems.push(`${path}.${key}: not declared in the output schema`)
    }
    for (const [key, property] of Object.entries(properties)) {
      const present = Object.hasOwn(value, key)
      if (property.required === true && !present) problems.push(`${path}.${key}: required but missing`)
      if (present) validate(property, value[key], `${path}.${key}`, problems)
    }
    return
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      problems.push(`${path}: expected array`)
      return
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`, problems))
    }
    return
  }
  if (schema.type === 'integer') {
    if (!(typeof value === 'number' && Number.isInteger(value))) problems.push(`${path}: expected integer`)
    return
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') problems.push(`${path}: expected boolean`)
    return
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') problems.push(`${path}: expected string`)
  }
}

const results = []

function record(name, args, value) {
  results.push({ name, args, value })
  return value
}

process.stdout.write('\nregistration\n')
{
  const { ctx } = mount()
  const sections = ctx.sections
  const names = [...ctx.registered.keys()].sort()
  equal('all eight tools are registered', names, [
    'cnblogs_account', 'cnblogs_delete_posts', 'cnblogs_get_post', 'cnblogs_ings',
    'cnblogs_list_posts', 'cnblogs_save_post', 'cnblogs_taxonomy', 'cnblogs_upload_image',
  ])
  ok('the usage section is registered once', sections.length === 1 && sections[0].name === 'dsh-cnblogs:usage')
  ok('the usage section warns about publishing', sections[0].text.includes('draft') && sections[0].text.includes('verified'))
  const disabled = mount({ enabled: false })
  ok('disabled mounts no tools', disabled.ctx.registered.size === 0)

  const templated = mount()
  const tokenFile = readFileSync(join(templated.dir, 'token'), 'utf8')
  ok('mounting creates the reported token file', tokenFile.includes('account.cnblogs.com/settings/tokens'))
  ok('the created token file holds no token', !/\b[0-9a-f]{32,}\b/i.test(tokenFile))
}

process.stdout.write('\naccount\n')
{
  const { ctx } = mount()
  record('cnblogs_account', { action: 'status' }, await call(ctx, 'cnblogs_account', { action: 'status' }))
  const status = results.at(-1).value
  ok('status reports the account', status.ok && status.authed && status.displayName === 'Alice' && status.blogApp === 'alice')
  equal('status names the token source', status.source, 'config')

  const unauthed = mount({ token: '' })
  const empty = record('cnblogs_account', { action: 'status' }, await call(unauthed.ctx, 'cnblogs_account', { action: 'status' }))
  ok('no token is explained, not thrown', empty.ok === true && empty.authed === false)
  ok('the explanation names the environment variable and file path',
    empty.message.includes('CNBLOGS_PAT') && empty.message.includes(join(unauthed.dir, 'token')))

  const cleared = record('cnblogs_account', { action: 'clear' }, await call(unauthed.ctx, 'cnblogs_account', { action: 'clear' }))
  ok('clear on an untouched template says what it removed', cleared.ok === true && cleared.message.includes('empty token template'))
}

process.stdout.write('\npublish: create from inline markdown\n')
{
  const { ctx, backend, dir } = mount()
  const saved = record('cnblogs_save_post', { body: '# hi\n\nhello', title: 'First post' },
    await call(ctx, 'cnblogs_save_post', { body: '# hi\n\nhello', title: 'First post' }))
  ok('created', saved.ok && saved.action === 'created')
  equal('a new post is a draft by default', saved.state, 'draft')
  equal('the public URL is protocol-absolute', saved.url, 'https://www.cnblogs.com/alice/p/100.html')
  equal('read-back verification passed', saved.verified, 'ok')
  const stored = backend.posts.get(saved.postId)
  ok('the backend stored the markdown', stored.postBody === '# hi\n\nhello' && stored.isMarkdown === true)
  ok('a draft carries isDraft', stored.isDraft === true && stored.isPublished === false)

  const published = record('cnblogs_save_post', { body: 'x', title: 'Public', status: 'publish' },
    await call(ctx, 'cnblogs_save_post', { body: 'x', title: 'Public', status: 'publish' }))
  equal('status publish flips the flags', published.state, 'published')
  ok('the backend sees a published post', backend.posts.get(published.postId).isPublished === true)

  const empty = record('cnblogs_save_post', { body: '   ' }, await call(ctx, 'cnblogs_save_post', { body: '   ' }))
  ok('an empty body is refused before any request', empty.ok === false && empty.message.includes('needs `file` or `body`'))
  rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('\npublish: front matter, tags and categories\n')
{
  const { ctx, backend, dir } = mount()
  const file = join(dir, 'post.md')
  writeFileSync(file, [
    '---',
    'title: 带 Front Matter 的文章',
    'tags: [rust, cli]',
    'categories:',
    '  - 后端',
    'status: publish',
    'slug: front-matter-post',
    'summary: 一段摘要',
    '---',
    '',
    'body with **markdown**',
  ].join('\n'), 'utf8')

  const saved = record('cnblogs_save_post', { file }, await call(ctx, 'cnblogs_save_post', { file }))
  ok('the front matter title is used', saved.title === '带 Front Matter 的文章')
  equal('status comes from the front matter', saved.state, 'published')
  equal('tags come from the front matter', saved.tags, ['rust', 'cli'])
  equal('a category name resolves to its id', saved.categoryIds, [10])
  const stored = backend.posts.get(saved.postId)
  ok('the front matter is stripped from the body', !stored.postBody.includes('title: 带 Front Matter'), stored.postBody)
  equal('the slug becomes entryName', stored.entryName, 'front-matter-post')
  equal('the summary becomes description', stored.description, '一段摘要')

  const unknown = record('cnblogs_save_post', { file, categories: ['不存在'] }, await call(ctx, 'cnblogs_save_post', { file, categories: ['不存在'] }))
  ok('an unknown category fails with the available names',
    unknown.ok === false && unknown.message.includes('unknown category') && unknown.message.includes('后端'))
  rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('\npublish: images are rehosted\n')
{
  const { ctx, backend, dir } = mount()
  writeFileSync(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary')
  const file = join(dir, 'with-image.md')
  writeFileSync(file, '![shot](./shot.png)\n\n![missing](./nope.png)\n', 'utf8')

  const saved = record('cnblogs_save_post', { file, title: 'With images' }, await call(ctx, 'cnblogs_save_post', { file, title: 'With images' }))
  ok('the save succeeds despite one missing image', saved.ok === true)
  equal('one image was uploaded', saved.imagesUploaded, 1)
  ok('the missing file is reported', saved.imagesFailed.length === 1 && saved.imagesFailed[0].includes('nope.png'))
  ok('a warning explains the broken image', saved.warnings.some((warning) => warning.includes('nope.png')))
  const stored = backend.posts.get(saved.postId)
  ok('the uploaded image URL replaced the local path', stored.postBody.includes('https://img2020.cnblogs.com/blog/1/uploaded.png'))
  ok('the missing image link is left alone', stored.postBody.includes('./nope.png'))
  ok('the image upload carried the form field', backend.calls.some((call) => call.url === `${BASE}/posts/body/images` && call.method === 'POST'))

  const docFile = join(dir, 'with-example.md')
  writeFileSync(docFile, '写法是 `![x](./example.png)`，再来一张真图：\n\n![real](./shot.png)\n', 'utf8')
  const doc = record('cnblogs_save_post', { file: docFile, title: 'Docs' }, await call(ctx, 'cnblogs_save_post', { file: docFile, title: 'Docs' }))
  ok('an image inside an inline code span is documentation, not an upload',
    doc.ok && doc.imagesUploaded === 1 && doc.imagesFailed.length === 0
    && !doc.warnings.some((warning) => warning.includes('example.png')))
  ok('the documented example survives verbatim', backend.posts.get(doc.postId).postBody.includes('`![x](./example.png)`'))
  rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('\npublish: the file mapping turns the next save into an update\n')
{
  const { ctx, backend, dir } = mount()
  const file = join(dir, 'mapped.md')
  writeFileSync(file, 'first version', 'utf8')
  const created = record('cnblogs_save_post', { file, title: 'Mapped' }, await call(ctx, 'cnblogs_save_post', { file, title: 'Mapped' }))
  ok('first save creates', created.action === 'created')
  const statePath = join(dir, 'state.json')
  const document = JSON.parse(readFileSync(statePath, 'utf8'))
  ok('the mapping is persisted', Object.values(document.files).some((entry) => entry.postId === created.postId))

  writeFileSync(file, 'second version', 'utf8')
  const updated = record('cnblogs_save_post', { file }, await call(ctx, 'cnblogs_save_post', { file }))
  ok('second save updates the same post', updated.action === 'updated' && updated.postId === created.postId)
  ok('the body was replaced', backend.posts.get(updated.postId).postBody === 'second version')
  equal('only one post exists', backend.posts.size, 1)

  const explicit = record('cnblogs_save_post', { body: 'by id', title: 'By id', postId: created.postId },
    await call(ctx, 'cnblogs_save_post', { body: 'by id', title: 'By id', postId: created.postId }))
  ok('an explicit post id also updates', explicit.action === 'updated' && explicit.postId === created.postId)
  rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('\nread and list\n')
{
  const { ctx, dir } = mount()
  await call(ctx, 'cnblogs_save_post', { body: 'read me', title: 'Read me', status: 'publish' })
  const listed = record('cnblogs_list_posts', {}, await call(ctx, 'cnblogs_list_posts', {}))
  ok('the list reports the total', listed.ok && listed.postsCount === 1 && listed.posts.length === 1)
  equal('the row state is published', listed.posts[0].state, 'published')
  ok('the rendered list contains the title and id', listed.message.includes('#100') && listed.message.includes('Read me'))

  const detail = record('cnblogs_get_post', { postId: 100 }, await call(ctx, 'cnblogs_get_post', { postId: 100 }))
  ok('reading returns the body', detail.ok && detail.body === 'read me' && detail.state === 'published')
  ok('the rendered detail contains the body', detail.message.includes('read me'))
  const truncated = record('cnblogs_get_post', { postId: 100, maxBodyChars: 4 }, await call(ctx, 'cnblogs_get_post', { postId: 100, maxBodyChars: 4 }))
  ok('a small cap truncates and says so', truncated.body === 'read' && truncated.bodyTruncated === true && truncated.bodyChars === 7)

  const missing = record('cnblogs_get_post', { postId: 999 }, await call(ctx, 'cnblogs_get_post', { postId: 999 }))
  ok('a missing post is an error result', missing.ok === false && missing.message.includes('404'))
  rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('\ndelete\n')
{
  const { ctx, backend, dir } = mount()
  const created = await call(ctx, 'cnblogs_save_post', { body: 'doomed', title: 'Doomed' })
  const deleted = record('cnblogs_delete_posts', { postIds: [created.postId] }, await call(ctx, 'cnblogs_delete_posts', { postIds: [created.postId] }))
  ok('the post is deleted', deleted.ok && deleted.deleted.length === 1 && !backend.posts.has(created.postId))

  const partial = record('cnblogs_delete_posts', { postIds: [999] }, await call(ctx, 'cnblogs_delete_posts', { postIds: [999] }))
  ok('a failed delete is reported, not hidden', partial.ok === false && partial.failed.length === 1 && partial.failed[0].includes('999'))
  const none = record('cnblogs_delete_posts', { postIds: [] }, await call(ctx, 'cnblogs_delete_posts', { postIds: [] }))
  ok('an empty id list is refused', none.ok === false)
  rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('\nimages, taxonomy and 闪存\n')
{
  const { ctx, backend, dir } = mount()
  const imagePath = join(dir, 'pic.png')
  writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]), 'binary')
  const uploaded = record('cnblogs_upload_image', { path: imagePath }, await call(ctx, 'cnblogs_upload_image', { path: imagePath }))
  ok('an explicit image upload returns the URL', uploaded.ok && uploaded.url.startsWith('https://img2020.cnblogs.com/') && uploaded.bytes === 4)

  const both = record('cnblogs_upload_image', { path: imagePath, url: 'https://example.com/a.png' },
    await call(ctx, 'cnblogs_upload_image', { path: imagePath, url: 'https://example.com/a.png' }))
  ok('exactly one image source is required', both.ok === false && both.message.includes('exactly one'))

  const categories = record('cnblogs_taxonomy', { action: 'list-categories' }, await call(ctx, 'cnblogs_taxonomy', { action: 'list-categories' }))
  ok('categories carry ids and counts', categories.ok && categories.categories.includes('10: 后端') && categories.categories.includes('11: Rust'))
  ok('the rendered taxonomy shows the tree flat', categories.message.includes('3 categories') && categories.message.includes('11: Rust'))

  const created = record('cnblogs_taxonomy', { action: 'create-category', title: '新分类' }, await call(ctx, 'cnblogs_taxonomy', { action: 'create-category', title: '新分类' }))
  ok('a category can be created', created.ok && backend.calls.some((call) => call.url === `${BASE}/category/blog/1` && call.method === 'POST'))

  const removed = record('cnblogs_taxonomy', { action: 'delete-category', categoryIds: [12] },
    await call(ctx, 'cnblogs_taxonomy', { action: 'delete-category', categoryIds: [12] }))
  ok('a category can be deleted', removed.ok && backend.deletedCategories.includes(12))

  const tags = record('cnblogs_taxonomy', { action: 'list-tags' }, await call(ctx, 'cnblogs_taxonomy', { action: 'list-tags' }))
  equal('tags are listed', tags.tags, ['rust', 'vscode'])

  const ing = record('cnblogs_ings', { action: 'list' }, await call(ctx, 'cnblogs_ings', { action: 'list' }))
  ok('闪存 are listed with their id and author', ing.ok && ing.ings[0].includes('#5') && ing.ings[0].includes('alice'))

  const published = record('cnblogs_ings', { action: 'publish', content: 'hello 闪存' },
    await call(ctx, 'cnblogs_ings', { action: 'publish', content: 'hello 闪存' }))
  ok('a 闪存 can be published', published.ok && published.message.includes('public'))

  const comment = record('cnblogs_ings', { action: 'comment', ingId: 5, content: 'nice' },
    await call(ctx, 'cnblogs_ings', { action: 'comment', ingId: 5, content: 'nice' }))
  ok('a 闪存 can be commented on', comment.ok && comment.message.includes('#5'))
  rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('\nfailure paths\n')
{
  const { ctx, backend, dir } = mount()
  backend.state.failStatus = 401
  const denied = record('cnblogs_save_post', { body: 'x', title: 'Denied' }, await call(ctx, 'cnblogs_save_post', { body: 'x', title: 'Denied' }))
  ok('an unauthorized publish fails with the status', denied.ok === false && denied.message.includes('401'))
  ok('no post was created', backend.posts.size === 0)
  const listDenied = record('cnblogs_list_posts', {}, await call(ctx, 'cnblogs_list_posts', {}))
  ok('a denied list is an error result', listDenied.ok === false && listDenied.message.includes('401'))
  backend.state.failStatus = 0

  const noToken = mount({ token: '' })
  const tokenless = record('cnblogs_list_posts', {}, await call(noToken.ctx, 'cnblogs_list_posts', {}))
  ok('a missing token is explained', tokenless.ok === false && tokenless.message.includes('CNBLOGS_PAT'))
  rmSync(dir, { recursive: true, force: true })
  rmSync(noToken.dir, { recursive: true, force: true })
}

process.stdout.write('\noutput schemas and renderers\n')
{
  const { ctx } = mount()
  const problems = []
  for (const { name, args, value } of results) {
    const tool = ctx.registered.get(name)
    validate(tool.output.schema, value, name, problems)
    let rendered
    try {
      rendered = tool.output.render(args, value)
    } catch (error) {
      problems.push(`${name}: render threw ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!Array.isArray(rendered) || rendered.length === 0 || typeof rendered[0].text !== 'string') {
      problems.push(`${name}: render did not produce text content`)
    }
  }
  ok(`every result matches its declared output schema (${results.length} results)`, problems.length === 0, problems.join('; '))
}

process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`${failures.length} of ${checks} checks failed:\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`all ${checks} checks passed\n`)
}
