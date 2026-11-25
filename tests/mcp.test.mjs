import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../lib/mcp.js'

const stateDir = mkdtempSync(join(tmpdir(), 'cnblogs-mcp-'))
const expectedTools = [
  'cnblogs_account',
  'cnblogs_list_posts',
  'cnblogs_get_post',
  'cnblogs_save_post',
  'cnblogs_delete_posts',
  'cnblogs_upload_image',
  'cnblogs_taxonomy',
  'cnblogs_ings',
]

const fetchFn = async (input, init = {}) => {
  const url = new URL(String(input))
  if (url.pathname === '/users') {
    return Response.json({ UserId: 'u1', SpaceUserID: 1, BlogId: 42, DisplayName: 'Alice', BlogApp: 'alice' })
  }
  if (url.pathname === '/posts/list') {
    return Response.json({
      postsCount: 1,
      pageIndex: 1,
      pageSize: 20,
      postList: [{
        id: 100,
        title: 'MCP test',
        url: '//www.cnblogs.com/alice/p/100.html',
        entryName: 'mcp-test',
        isDraft: true,
        isPublished: false,
        datePublished: '2026-11-25T10:00:00',
        dateUpdated: '2026-11-25T10:00:00',
        viewCount: 3,
      }],
    })
  }
  return new Response(`unexpected ${init.method ?? 'GET'} ${url.pathname}`, { status: 404 })
}

const server = createMcpServer({
  config: {
    enabled: true,
    token: 'a'.repeat(64),
    tokenFile: '',
    stateDir,
    blogBackend: 'https://write.cnblogs.com',
    openapi: 'https://api.cnblogs.com',
    timeoutMs: 5_000,
    maxBodyChars: 200_000,
    maxUploadBytes: 10_485_760,
    extractImages: true,
    extractWebImages: false,
    keepFrontMatter: false,
    defaultStatus: 'draft',
    defaultAccess: 'public',
    promptSection: false,
  },
  fetchFn,
})
const client = new Client({ name: 'cnblogs-mcp-test', version: '1.0.0' })
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...expectedTools].sort())
  assert.ok(tools.every((tool) => tool.inputSchema.type === 'object' && tool.outputSchema.type === 'object'))
  assert.ok(tools.every((tool) => tool.annotations?.openWorldHint === true))
  assert.equal(tools.find((tool) => tool.name === 'cnblogs_delete_posts')?.annotations?.destructiveHint, true)

  const account = await client.callTool({ name: 'cnblogs_account', arguments: { action: 'status' } })
  assert.equal(account.isError, false)
  assert.equal(account.structuredContent?.authed, true)
  assert.equal(account.structuredContent?.displayName, 'Alice')
  assert.match(account.content[0].text, /Alice/)

  const posts = await client.callTool({ name: 'cnblogs_list_posts', arguments: { page: 1, pageSize: 20 } })
  assert.equal(posts.isError, false)
  assert.equal(posts.structuredContent?.postsCount, 1)
  assert.equal(posts.structuredContent?.posts[0].title, 'MCP test')

  const invalid = await client.callTool({ name: 'cnblogs_get_post', arguments: { postId: 'not-a-number' } })
  assert.equal(invalid.isError, true)

  const missingTokenDir = join(stateDir, 'missing-token')
  const unauthenticated = createMcpServer({
    config: {
      enabled: true,
      token: '',
      tokenFile: join(missingTokenDir, 'token'),
      stateDir: missingTokenDir,
      blogBackend: 'https://write.cnblogs.com',
      openapi: 'https://api.cnblogs.com',
      timeoutMs: 5_000,
      maxBodyChars: 200_000,
      maxUploadBytes: 10_485_760,
      extractImages: true,
      extractWebImages: false,
      keepFrontMatter: false,
      defaultStatus: 'draft',
      defaultAccess: 'public',
      promptSection: false,
    },
  })
  const noTokenClient = new Client({ name: 'cnblogs-mcp-no-token-test', version: '1.0.0' })
  const [noTokenClientTransport, noTokenServerTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([unauthenticated.connect(noTokenServerTransport), noTokenClient.connect(noTokenClientTransport)])
  const status = await noTokenClient.callTool({ name: 'cnblogs_account', arguments: { action: 'status' } })
  assert.equal(status.structuredContent?.authed, false)
  assert.match(status.content[0].text, /no cnblogs token configured/)
  await noTokenClient.close()
  await unauthenticated.close()

  const savedState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
  assert.equal(savedState.account.displayName, 'Alice')
  process.stdout.write('MCP protocol checks passed: 8 tools, schemas, annotations, account, listing, validation, and missing-token guidance\n')
} finally {
  await client.close()
  await server.close()
  rmSync(stateDir, { recursive: true, force: true })
}
