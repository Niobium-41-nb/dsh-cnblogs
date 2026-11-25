#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AuthStore, ensureTokenTemplate } from './auth.ts'
import { resolveConfig, resolveStatePath, resolveTokenPath } from './config.ts'
import { StateStore } from './store.ts'
import { registerTools } from './tools.ts'
import type { ToolsOptions } from './tools.ts'

const TOOL_TITLES: Record<string, string> = {
  cnblogs_account: 'Cnblogs Account',
  cnblogs_list_posts: 'List Cnblogs Posts',
  cnblogs_get_post: 'Read Cnblogs Post',
  cnblogs_save_post: 'Save Cnblogs Post',
  cnblogs_delete_posts: 'Delete Cnblogs Posts',
  cnblogs_upload_image: 'Upload Cnblogs Image',
  cnblogs_taxonomy: 'Manage Cnblogs Taxonomy',
  cnblogs_ings: 'Manage Cnblogs Statuses',
}

const TOOL_ANNOTATIONS: Record<string, { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }> = {
  cnblogs_account: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  cnblogs_list_posts: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  cnblogs_get_post: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  cnblogs_save_post: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  cnblogs_delete_posts: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  cnblogs_upload_image: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  cnblogs_taxonomy: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  cnblogs_ings: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}

function withAnnotations(schema: z.ZodTypeAny, node: JsonSchemaNode): z.ZodTypeAny {
  let result = schema
  if (node.description !== undefined) result = result.describe(node.description)
  if (node.default !== undefined) result = result.default(node.default as never)
  return result
}

function schemaToZod(node: JsonSchemaNode): z.ZodTypeAny {
  if (node.oneOf !== undefined) {
    const [first, second, ...rest] = node.oneOf.map(schemaToZod)
    if (first === undefined || second === undefined) throw new Error('MCP schema oneOf needs at least two branches')
    return withAnnotations(z.union([first, second, ...rest]), node)
  }

  let schema: z.ZodTypeAny
  if (node.const !== undefined) {
    schema = z.literal(node.const)
  } else if (node.enum !== undefined) {
    const [first, second, ...rest] = node.enum.map((value) => z.literal(value))
    if (first === undefined) throw new Error('MCP schema enum must not be empty')
    schema = second === undefined ? first : z.union([first, second, ...rest])
  } else {
    switch (node.type) {
      case 'string':
        schema = z.string()
        break
      case 'number':
        schema = z.number()
        break
      case 'integer':
        schema = z.number().int()
        break
      case 'boolean':
        schema = z.boolean()
        break
      case 'null':
        schema = z.null()
        break
      case 'array':
        schema = z.array(node.items === undefined ? z.unknown() : schemaToZod(node.items))
        break
      case 'object': {
        const properties = node.properties ?? {}
        const required = new Set(node.required ?? [])
        const shape = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
          const converted = schemaToZod(value)
          return [key, required.has(key) ? converted : converted.optional()]
        }))
        schema = node.additionalProperties === false ? z.strictObject(shape) : z.object(shape)
        break
      }
      default:
        schema = z.unknown()
    }
  }
  return withAnnotations(schema, node)
}

function objectShape(schema: JsonSchemaNode): z.ZodRawShape {
  if (schema.type !== 'object' || schema.properties === undefined) {
    throw new Error('MCP tool input and output schemas must be objects')
  }
  const required = new Set(schema.required ?? [])
  return Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
    const converted = schemaToZod(value)
    return [key, required.has(key) ? converted : converted.optional()]
  }))
}

function collectTools(options: ToolsOptions): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        tools.push(definition)
      },
    },
  } as unknown as Context
  registerTools(ctx, options)
  return tools
}

export function createMcpServer(options: Partial<ToolsOptions> = {}): McpServer {
  const server = new McpServer({ name: 'cnblogs-mcp-server', version: '0.2.0' })
  const config = options.config ?? resolveConfig(undefined)
  const auth = options.auth ?? new AuthStore({ config, env: process.env })
  const store = options.store ?? new StateStore(resolveStatePath(config))
  const tools = collectTools({
    config,
    auth,
    store,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  })

  let exclusiveTail: Promise<void> = Promise.resolve()
  const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const scheduled = exclusiveTail.then(operation)
    exclusiveTail = scheduled.then(() => undefined, () => undefined)
    return scheduled
  }

  for (const tool of tools) {
    const annotations = TOOL_ANNOTATIONS[tool.name]
    if (annotations === undefined) throw new Error(`Missing MCP annotations for ${tool.name}`)
    server.registerTool(
      tool.name,
      {
        title: TOOL_TITLES[tool.name] ?? tool.name,
        description: tool.description,
        inputSchema: objectShape(tool.parameters),
        outputSchema: objectShape(tool.output.schema),
        annotations: { ...annotations, openWorldHint: true },
      },
      async (args, extra) => {
        const execute = async (): Promise<Record<string, unknown>> => {
          extra.signal.throwIfAborted()
          return await tool.execute(args, { signal: extra.signal } as ToolRunContext) as Record<string, unknown>
        }
        const result = tool.isConcurrencySafe?.(args) === true ? await execute() : await runExclusive(execute)
        const structuredContent = result
        const message = typeof structuredContent.message === 'string'
          ? structuredContent.message
          : JSON.stringify(result)
        return {
          content: [{ type: 'text', text: message }],
          structuredContent,
          isError: structuredContent.ok === false,
        }
      },
    )
  }
  return server
}

export async function startMcpServer(): Promise<void> {
  const config = resolveConfig(undefined)
  const tokenPath = resolveTokenPath(config)
  const template = ensureTokenTemplate(tokenPath)
  process.stderr.write(`[cnblogs-mcp] token file: ${tokenPath} (${template})\n`)
  const server = createMcpServer({ config })
  await server.connect(new StdioServerTransport())

  const shutdown = (): void => {
    void server.close().catch(() => process.exitCode = 1)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMcpServer().catch((error: unknown) => {
    process.stderr.write(`[cnblogs-mcp] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
