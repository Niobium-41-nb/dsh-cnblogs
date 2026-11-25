/**
 * Read-only live check against the real cnblogs API.
 *
 * It resolves the same token the tools use and asks for the account and the
 * first page of posts. Nothing is written, published or deleted.
 *
 *   node --experimental-strip-types tests/live.check.mjs
 *
 * Exit codes: 0 verified, 1 request failed, 2 no token configured.
 */

import { resolveConfig, resolveTokenPath } from '../src/config.ts'
import { AuthStore } from '../src/auth.ts'
import { CnbApi, flattenCategories } from '../src/api.ts'

const config = resolveConfig({})
const auth = new AuthStore({ config, env: process.env })
const resolved = await auth.resolve()

if (resolved === undefined) {
  process.stdout.write('no token configured\n')
  process.stdout.write(`put a personal access token (one line) in ${resolveTokenPath(config)}\n`)
  process.stdout.write('or export CNBLOGS_PAT\n')
  process.exit(2)
}

process.stdout.write(`token source: ${resolved.source}\n`)
const api = new CnbApi(config, resolved.token)

try {
  const account = await api.getAccount()
  process.stdout.write(`account: ${account.displayName} — https://www.cnblogs.com/${account.blogApp} (blog ${account.blogId})\n`)
  const page = await api.listPosts({ page: 1, pageSize: 3 })
  process.stdout.write(`posts: ${page.postsCount} total, showing ${page.postList.length}\n`)
  for (const post of page.postList) {
    const state = post.isPublished ? 'published' : post.isDraft ? 'draft' : 'unpublished'
    process.stdout.write(`  - #${post.id} [${state}] ${post.title}\n`)
  }
  const categories = flattenCategories(await api.listCategories())
  process.stdout.write(`categories: ${categories.length}${categories.length > 0 ? ` (${categories.map((node) => `${node.categoryId}:${node.title}`).join(', ')})` : ''}\n`)
  const tags = await api.listTags()
  process.stdout.write(`tags: ${tags.length}\n`)
  process.stdout.write('live check passed\n')
} catch (error) {
  process.stderr.write(`live check failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
