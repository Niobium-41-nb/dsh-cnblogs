/**
 * Pure-helper tests: front matter, image discovery and rewriting, post projection,
 * configuration, the state store, and token sources.
 *
 * Run: node --experimental-strip-types tests/unit.test.mjs
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flattenCategories, normalizeAccount, normalizeCategories, normalizeCategory, normalizeIng, normalizePost,
  normalizePostList, normalizePostListItem, normalizeUrl,
} from '../src/api.ts'
import { AuthStore, ensureTokenTemplate, readTokenFile } from '../src/auth.ts'
import {
  assertTokenShape, looksLikePat, normalizeAccess, normalizeStatus, resolveConfig, resolveStatePath,
  resolveStateDir, resolveTokenPath,
} from '../src/config.ts'
import { fmBool, fmList, fmNumber, fmText, parseFrontMatter } from '../src/frontmatter.ts'
import {
  applyReplacements, codeRanges, extensionForMime, findImageRefs, isCnblogsHost, mimeForPath, parseDataUrl,
  resolveLocalImagePath,
} from '../src/images.ts'
import {
  categoryIndex, hasUnrehostedImages, loadSource, normalizeBody, postState, publicUrl,
  resolveCategoryIds,
} from '../src/posts.ts'
import { StateStore, mappingKey } from '../src/store.ts'

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

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-cnblogs-${tag}-`))
}

function baseConfig(overrides = {}) {
  return resolveConfig({ stateDir: tempDir('cfg'), token: 'a'.repeat(64), ...overrides })
}

process.stdout.write('\nfront matter\n')
{
  const text = [
    '---',
    'title: 我的文章',
    'tags: [rust, cnblogs]',
    'categories:',
    '  - 后端',
    '  - "前端开发"',
    'status: publish',
    'postId: 42',
    'pinned: true',
    '# a comment line',
    '---',
    '',
    '# 正文',
    'end',
  ].join('\n')
  const parsed = parseFrontMatter(text)
  ok('a closed block is detected', parsed.present)
  equal('title is parsed', fmText(parsed.data, ['title']), '我的文章')
  equal('inline list becomes a list', fmList(parsed.data, ['tags']), ['rust', 'cnblogs'])
  equal('block list becomes a list', fmList(parsed.data, ['categories']), ['后端', '前端开发'])
  equal('postId is numeric', fmNumber(parsed.data, ['postId']), 42)
  equal('booleans keep their type', fmBool(parsed.data, ['pinned']), true)
  equal('body starts after the fence', parsed.body, '# 正文\nend')

  const leadingBlanks = parseFrontMatter('---\ntitle: x\n---\n\n\nbody')
  equal('blank lines left by the removed block are dropped', leadingBlanks.body, 'body')

  const crlf = parseFrontMatter('---\r\ntitle: x\r\n---\r\nbody\r\n')
  ok('CRLF files parse', crlf.present && fmText(crlf.data, ['title']) === 'x' && crlf.body === 'body\r\n')

  const noFence = parseFrontMatter('---\nnot a front matter block\n')
  ok('a lone --- is not front matter', noFence.present === false && noFence.body.startsWith('---'))

  const empty = parseFrontMatter('---\ntitle:\n---\nbody')
  ok('an empty value is not text', fmText(empty.data, ['title']) === undefined)

  const quoted = parseFrontMatter('---\ntitle: "a: b"\n---\n')
  equal('quoted values may contain colons', fmText(quoted.data, ['title']), 'a: b')

  const scalarList = parseFrontMatter('---\ntags: one, two\n---\n')
  equal('comma scalars split into a list', fmList(scalarList.data, ['tags']), ['one', 'two'])
}

process.stdout.write('\nimage discovery\n')
{
  const body = [
    '![shot](./images/shot.png)',
    'text',
    '<img class="x" src="https://example.com/a.png" />',
    '![inline](data:image/png;base64,iVBORw0KGgo=)',
    '![angle](<./my shot.png>)',
  ].join('\n')
  const refs = findImageRefs(body)
  equal('four references are found', refs.length, 4)
  equal('markdown URL is captured', refs[0].url, './images/shot.png')
  ok('markdown kind', refs[0].kind === 'markdown')
  equal('html URL is captured', refs[1].url, 'https://example.com/a.png')
  ok('html kind', refs[1].kind === 'html')
  ok('data URL is discovered with its prefix', refs[2].url.startsWith('data:image/png;base64,'))
  equal('angle brackets are excluded from the range', refs[3].url, './my shot.png')
  equal('the range covers only the URL', body.slice(refs[0].start, refs[0].end), './images/shot.png')

  const rewritten = applyReplacements(body, [
    { from: refs[0], to: 'https://img.example/1.png' },
    { from: refs[3], to: 'https://img.example/2.png' },
  ])
  ok('markdown links are rewritten', rewritten.includes('![shot](https://img.example/1.png)'))
  ok('angle-bracket links are rewritten', rewritten.includes('![angle](<https://img.example/2.png>)'))
  ok('other references are untouched', rewritten.includes('<img class="x" src="https://example.com/a.png" />'))
}

process.stdout.write('\nimages inside code are documentation, not uploads\n')
{
  const fenced = [
    '```markdown',
    '![shot](./example.png)',
    '```',
    '',
    '![real](./real.png)',
  ].join('\n')
  const fencedRefs = findImageRefs(fenced)
  equal('a fenced block is skipped', fencedRefs.length, 1)
  equal('the image outside the fence is kept', fencedRefs[0].url, './real.png')

  const inline = '写法是 `![shot](./example.png)`，正文里再来一张 ![real](./real.png)'
  const inlineRefs = findImageRefs(inline)
  equal('an inline code span is skipped', inlineRefs.length, 1)
  equal('the prose image is kept', inlineRefs[0].url, './real.png')

  const tilde = '~~~\n![x](./a.png)\n~~~\n'
  equal('tilde fences are skipped too', findImageRefs(tilde).length, 0)

  const unterminated = '```\n![x](./a.png)\n'
  equal('an unterminated fence makes the rest code', findImageRefs(unterminated).length, 0)

  const ranges = codeRanges(fenced)
  ok('code ranges cover the whole block', ranges.length === 1 && ranges[0].end > ranges[0].start)
}

process.stdout.write('\nimage helpers\n')
{
  equal('png mime', mimeForPath('a/b/c.PNG'), 'image/png')
  equal('jpeg mime', mimeForPath('x.jpeg'), 'image/jpeg')
  equal('text is not an image', mimeForPath('notes.txt'), undefined)
  ok('jpeg extension is accepted', ['jpg', 'jpeg'].includes(extensionForMime('image/jpeg')))
  equal('unknown mime falls back to png', extensionForMime('application/octet-stream'), 'png')
  ok('cnblogs host is detected', isCnblogsHost('https://img2020.cnblogs.com/blog/1/a.png'))
  ok('a lookalike host is not', !isCnblogsHost('https://notcnblogs.com/a.png'))
  ok('invalid URL is not a cnblogs host', !isCnblogsHost('not a url'))

  const relative = resolveLocalImagePath('./a%20b/c.png?x=1', 'C:\\posts')
  ok('relative paths resolve and decode', relative.endsWith(join('C:\\posts', 'a b', 'c.png')) || relative.endsWith(join('/posts', 'a b', 'c.png')), relative)
  equal('absolute posix paths stay absolute', resolveLocalImagePath('/tmp/a.png', '/posts'), '/tmp/a.png')
  equal('file URLs are unwrapped', resolveLocalImagePath('file:///tmp/a.png', '/posts'), '/tmp/a.png')

  const dataUrl = parseDataUrl('data:image/png;base64,aGVsbG8=')
  ok('base64 data URLs decode', dataUrl !== undefined && dataUrl.mime === 'image/png' && dataUrl.bytes.length === 5)
  ok('non-image data URLs are rejected', parseDataUrl('data:text/plain;base64,aGVsbG8=') === undefined)
  ok('non-base64 data URLs are rejected', parseDataUrl('data:image/png,notbase64') === undefined)
}

process.stdout.write('\npost projection\n')
{
  equal('published wins', postState({ isPublished: true, isDraft: true }), 'published')
  equal('draft state', postState({ isPublished: false, isDraft: true }), 'draft')
  equal('unpublished state', postState({ isPublished: false, isDraft: false }), 'unpublished')
  equal('public URL', publicUrl('alice', 7), 'https://www.cnblogs.com/alice/p/7.html')
  equal('no blog app means no URL', publicUrl('', 7), '')
  equal('CRLF normalizes', normalizeBody('a\r\nb\r\n'), 'a\nb')
  equal('trailing whitespace normalizes', normalizeBody('a   \nb'), 'a\nb')
  ok('local images are detected', hasUnrehostedImages('![a](./a.png)'))
  ok('cnblogs images are fine', !hasUnrehostedImages('![a](https://img.cnblogs.com/a.png)'))
  ok('remote images are fine', !hasUnrehostedImages('![a](https://example.com/a.png)'))

  const flat = flattenCategories([
    { categoryId: 1, title: 'A', children: [{ categoryId: 2, title: 'B', children: null }] },
    { categoryId: 3, title: 'C' },
  ])
  equal('categories flatten depth-first', flat.map((node) => node.categoryId), [1, 2, 3])
  const index = categoryIndex(flat)
  equal('index maps a title to its ids', index.get('a'), [1])

  const config = baseConfig()
  const source = loadSource({ body: 'hello' }, config)
  ok('inline body loads without a file', source.text === 'hello' && source.filePath === '')
  let missing = ''
  try {
    loadSource({ file: join(tmpdir(), 'dsh-cnblogs-does-not-exist.md') }, config)
  } catch (error) {
    missing = error.message
  }
  ok('a missing file is reported by name', missing.includes('post file not found'), missing)
}

process.stdout.write('\nconfig\n')
{
  const defaults = resolveConfig(undefined)
  equal('default backend', defaults.blogBackend, 'https://write.cnblogs.com/api')
  equal('default openapi', defaults.openapi, 'https://api.cnblogs.com/api')
  equal('default status', defaults.defaultStatus, 'draft')
  equal('default access', defaults.defaultAccess, 'public')
  ok('images are rehosted by default', defaults.extractImages === true)
  ok('third-party images are not rehosted by default', defaults.extractWebImages === false)

  equal('status alias', normalizeStatus('Published'), 'publish')
  equal('access alias', normalizeAccess('private'), 'owner')
  equal('unknown status', normalizeStatus('maybe'), undefined)
  ok('a JWT is not a PAT', looksLikePat('aaa.bbb.ccc') === false)
  ok('a PAT is opaque', looksLikePat('a'.repeat(64)) === true)
  let shapeError = ''
  try {
    assertTokenShape('short')
  } catch (error) {
    shapeError = error.message
  }
  ok('short tokens are rejected', shapeError.includes('at least 20'), shapeError)

  const config = baseConfig({ stateDir: join(tmpdir(), 'dsh-cnblogs-state') })
  equal('state dir resolves from config', resolveStateDir(config), join(tmpdir(), 'dsh-cnblogs-state'))
  equal('state path', resolveStatePath(config), join(tmpdir(), 'dsh-cnblogs-state', 'state.json'))
  equal('token file defaults inside the state dir', resolveTokenPath(config), join(tmpdir(), 'dsh-cnblogs-state', 'token'))
  const custom = baseConfig({ tokenFile: join(tmpdir(), 'pat.txt') })
  equal('token file honors config', resolveTokenPath(custom), join(tmpdir(), 'pat.txt'))
}

process.stdout.write('\nstate store\n')
{
  const dir = tempDir('state')
  const path = join(dir, 'state.json')
  const store = new StateStore(path)
  equal('a missing document is empty', store.read().files, {})
  store.setFile('C:\\posts\\a.md', { postId: 12, url: 'https://x', title: 'A', updatedAt: 'now' })
  equal('a mapping round-trips', store.getFile('C:\\posts\\a.md')?.postId, 12)
  ok('the file is private on POSIX', process.platform === 'win32' || (statSync(path).mode & 0o077) === 0)
  if (process.platform === 'win32') {
    equal('mapping keys fold case on Windows', mappingKey('C:\\Posts\\A.md'), mappingKey('c:\\posts\\a.md'))
  }
  store.setAccount({ displayName: 'Alice', blogApp: 'alice', blogId: 3, userId: 'u', spaceUserId: 1, avatar: '', isVip: false, joined: '' })
  equal('the account is cached', store.read().account?.blogApp, 'alice')
  store.removeFile('C:\\posts\\a.md')
  ok('a mapping is removable', store.getFile('C:\\posts\\a.md') === undefined)

  writeFileSync(path, '{ not json', 'utf8')
  equal('a corrupt document reads as empty', store.read().files, {})
  writeFileSync(path, JSON.stringify({ version: 1, files: { k: { postId: 'nope' } } }), 'utf8')
  equal('invalid entries are dropped', store.read().files, {})
  rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('\ntoken sources\n')
{
  const dir = tempDir('auth')
  const tokenPath = join(dir, 'token')
  writeFileSync(tokenPath, '# comment\n\n' + 'b'.repeat(64) + '\n', 'utf8')
  equal('a commented token file resolves to the token', readTokenFile(tokenPath), 'b'.repeat(64))
  equal('a missing token file is undefined', readTokenFile(join(dir, 'nope')), undefined)

  const config = resolveConfig({ stateDir: dir, tokenFile: tokenPath })
  delete process.env.CNBLOGS_PAT
  delete process.env.CNBLOGS_TOKEN
  const fromFile = await new AuthStore({ config, env: process.env }).resolve()
  equal('the file is the last source', fromFile?.source, 'file')

  const envStore = new AuthStore({ config: resolveConfig({ stateDir: dir }), env: { CNBLOGS_PAT: 'c'.repeat(64) } })
  const fromEnv = await envStore.resolve()
  equal('the environment outranks the file', fromEnv?.source, 'env')

  const inline = new AuthStore({ config: resolveConfig({ stateDir: dir, token: 'd'.repeat(64) }), env: {} })
  equal('inline configuration wins', (await inline.resolve())?.source, 'config')

  const saving = new AuthStore({ config: resolveConfig({ stateDir: dir }), env: {} })
  const savedAs = await saving.save('e'.repeat(64))
  equal('a token with no credential seam is written to the file', savedAs, 'file')
  equal('the written token is readable', readTokenFile(tokenPath), 'e'.repeat(64))
  ok('the written token file is private', process.platform === 'win32' || (statSync(tokenPath).mode & 0o077) === 0)
  const cleared = await saving.clear()
  ok('clear removes the token file', cleared.tokenFile === true && cleared.hadToken === true && readTokenFile(tokenPath) === undefined)

  const recorded = []
  const ctx = {
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        async resolve(ref) {
          recorded.push(`resolve:${ref}`)
          return ref === 'CNBLOGS_PAT' ? { value: 'f'.repeat(64) } : undefined
        },
        async set(ref, value) {
          recorded.push(`set:${ref}:${value.length}`)
        },
        async unset(ref) {
          recorded.push(`unset:${ref}`)
        },
      }
    },
  }
  const seam = new AuthStore({ config: resolveConfig({ stateDir: dir }), ctx, env: {} })
  equal('the credential seam is preferred', (await seam.resolve())?.source, 'credential')
  equal('saving goes to the seam', await seam.save('g'.repeat(64)), 'credential')
  await seam.clear()
  ok('the seam is addressed by the documented key', recorded.includes('resolve:CNBLOGS_PAT') && recorded.includes('set:CNBLOGS_PAT:64'))

  const templatePath = join(dir, 'nested', 'token')
  equal('a missing token file is templated so the path exists', ensureTokenTemplate(templatePath), 'created')
  ok('the template explains where a token comes from', readFileSync(templatePath, 'utf8').includes('account.cnblogs.com/settings/tokens'))
  equal('a comment-only template carries no token', readTokenFile(templatePath), undefined)
  equal('an existing file is never overwritten', ensureTokenTemplate(templatePath), 'present')
  writeFileSync(templatePath, `${'h'.repeat(64)}\n`, 'utf8')
  equal('a real token still wins over the template step', ensureTokenTemplate(templatePath), 'present')
  equal('the token is readable after that', readTokenFile(templatePath), 'h'.repeat(64))
  rmSync(dir, { recursive: true, force: true })
}

process.stdout.write('\napi normalization\n')
{
  equal('protocol-relative URLs gain a scheme', normalizeUrl('//www.cnblogs.com/x'), 'https://www.cnblogs.com/x')
  const account = normalizeAccount({ UserId: 'u1', BlogId: 9, DisplayName: 'Alice', BlogApp: 'alice', Avatar: '//a', IsVip: true })
  ok('the PascalCase account is mapped', account.blogId === 9 && account.displayName === 'Alice' && account.blogApp === 'alice' && account.isVip)
  const post = normalizePost({ id: 5, title: 'T', postBody: 'b', tags: null, categoryIds: [1, 'x'] })
  ok('a post normalizes null lists', Array.isArray(post.tags) && post.tags.length === 0 && post.categoryIds.length === 1)
  const list = normalizePostList({ postsCount: 41, pageIndex: 2, pageSize: 20, postList: [{ id: 1, title: 'a', isPublished: true }] })
  ok('the list keeps the total', list.postsCount === 41 && list.pageIndex === 2 && list.postList.length === 1)
  const row = normalizePostListItem({ id: 2, title: 'b', url: '//u', datePublished: '2024-01-01' })
  ok('a row normalizes its URL', row.url === 'https://u' && row.viewCount === 0)
  const ing = normalizeIng({ Id: 7, Content: 'hello', IsPrivate: true, UserDisplayName: 'Bob', CommentCount: 2 })
  ok('a 闪存 row is camelCased from PascalCase', ing.id === 7 && ing.content === 'hello' && ing.isPrivate && ing.userDisplayName === 'Bob' && ing.commentCount === 2)
  const category = normalizeCategory({ categoryId: 4, title: 'C', children: [{ categoryId: 5, title: 'D' }] })
  ok('nested categories normalize', category.children?.length === 1 && category.children[0].categoryId === 5)
  equal('the live {categories} envelope is unwrapped',
    normalizeCategories({ categories: [{ categoryId: 1, title: 'A' }], parent: null }).length, 1)
  equal('a bare category array still works', normalizeCategories([{ categoryId: 2, title: 'B' }]).length, 1)
  equal('an object without a list yields no categories', normalizeCategories({ parent: null }), [])
  equal('null yields no categories', normalizeCategories(null), [])
}

process.stdout.write('\ncategory resolution\n')
{
  const api = {
    async listCategories() {
      return [
        { categoryId: 10, title: '后端', children: [{ categoryId: 11, title: 'Rust' }] },
        { categoryId: 12, title: '重复' },
        { categoryId: 13, title: '重复' },
      ]
    },
  }
  equal('names resolve to ids', await resolveCategoryIds(api, ['Rust']), [11])
  equal('numeric ids pass through', await resolveCategoryIds(api, [12]), [12])
  equal('numeric strings resolve', await resolveCategoryIds(api, ['10']), [10])
  let unknown = ''
  try {
    await resolveCategoryIds(api, ['不存在'])
  } catch (error) {
    unknown = error.message
  }
  ok('an unknown name lists what exists', unknown.includes('unknown category'), unknown)
  let ambiguous = ''
  try {
    await resolveCategoryIds(api, ['重复'])
  } catch (error) {
    ambiguous = error.message
  }
  ok('an ambiguous name is rejected', ambiguous.includes('matches 2 categories'), ambiguous)
  let badId = ''
  try {
    await resolveCategoryIds(api, [99])
  } catch (error) {
    badId = error.message
  }
  ok('an unknown id is rejected', badId.includes('unknown category id 99'), badId)
}

process.stdout.write('\n')
if (failures.length > 0) {
  process.stdout.write(`${failures.length} of ${checks} checks failed:\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`all ${checks} checks passed\n`)
}
