/**
 * Configuration, path resolution, and the token sources this plugin accepts.
 *
 * No settings-namespace dependency: the state file and the token file are small
 * files the plugin owns, so a setup survives profile changes and can be edited
 * by hand without a running harness.
 * @module dsh-cnblogs/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { AccessLevel, Config as ConfigShape, PostStatus } from './types.ts'

/** Expand a leading `~` the way the harness's own helpers do. */
export function expandHomePath(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

/** Resolve the DeepSeek Harness home without importing its private packages. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(expandHomePath(fromEnv))
  return join(homedir(), '.dsh')
}

/** Directory holding this plugin's state, configurable through `stateDir` or `DSH_CNBLOGS_STATE_DIR`. */
export function resolveStateDir(config: ConfigShape, env: NodeJS.ProcessEnv = process.env): string {
  if (config.stateDir !== undefined && config.stateDir.trim().length > 0) {
    return resolve(expandHomePath(config.stateDir))
  }
  const fromEnv = env.DSH_CNBLOGS_STATE_DIR
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(expandHomePath(fromEnv))
  return join(resolveDshHome(env), 'dsh-cnblogs')
}

/** The state document path. */
export function resolveStatePath(config: ConfigShape, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStateDir(config, env), 'state.json')
}

/** The PAT file path: `tokenFile` when set, otherwise `<stateDir>/token`. */
export function resolveTokenPath(config: ConfigShape, env: NodeJS.ProcessEnv = process.env): string {
  if (config.tokenFile !== undefined && config.tokenFile.trim().length > 0) {
    return resolve(expandHomePath(config.tokenFile))
  }
  return join(resolveStateDir(config, env), 'token')
}

/** Schemastery declaration shown in `cordis.yml`. */
export const Config: z<ConfigShape> = z.object({
  enabled: z.boolean().default(true),
  token: z.string().default(''),
  tokenFile: z.string().default(''),
  stateDir: z.string(),
  blogBackend: z.string().default('https://write.cnblogs.com/api'),
  openapi: z.string().default('https://api.cnblogs.com/api'),
  timeoutMs: z.natural().default(30_000),
  maxBodyChars: z.natural().default(200_000),
  maxUploadBytes: z.natural().default(10_485_760),
  extractImages: z.boolean().default(true),
  extractWebImages: z.boolean().default(false),
  keepFrontMatter: z.boolean().default(false),
  defaultStatus: z.union([z.const('draft'), z.const('publish')]).default('draft'),
  defaultAccess: z.union([z.const('public'), z.const('login'), z.const('owner')]).default('public'),
  promptSection: z.boolean().default(true),
})

/** Complete defaults, so direct instantiation never reads `undefined` knobs. */
export const DEFAULTS: ConfigShape = {
  enabled: true,
  token: '',
  tokenFile: '',
  stateDir: '',
  blogBackend: 'https://write.cnblogs.com/api',
  openapi: 'https://api.cnblogs.com/api',
  timeoutMs: 30_000,
  maxBodyChars: 200_000,
  maxUploadBytes: 10_485_760,
  extractImages: true,
  extractWebImages: false,
  keepFrontMatter: false,
  defaultStatus: 'draft',
  defaultAccess: 'public',
  promptSection: true,
}

/** Merge a partial configuration over the defaults, normalizing the enum-like knobs. */
export function resolveConfig(raw: Partial<ConfigShape> | undefined): ConfigShape {
  const source = raw ?? {}
  const merged: ConfigShape = {
    ...DEFAULTS,
    ...source,
    defaultStatus: normalizeStatus(source.defaultStatus) ?? DEFAULTS.defaultStatus,
    defaultAccess: normalizeAccess(source.defaultAccess) ?? DEFAULTS.defaultAccess,
  }
  return merged
}

/** Accept `draft` / `publish` (and the obvious aliases); return undefined for anything else. */
export function normalizeStatus(value: unknown): PostStatus | undefined {
  if (typeof value !== 'string') return undefined
  const lowered = value.trim().toLowerCase()
  if (lowered === 'draft') return 'draft'
  if (lowered === 'publish' || lowered === 'published' || lowered === 'public') return 'publish'
  return undefined
}

/** Accept `public` / `login` / `owner` (and `private` as a synonym of owner). */
export function normalizeAccess(value: unknown): AccessLevel | undefined {
  if (typeof value !== 'string') return undefined
  const lowered = value.trim().toLowerCase()
  if (lowered === 'public' || lowered === 'all' || lowered === 'everyone') return 'public'
  if (lowered === 'login' || lowered === 'authenticated' || lowered === 'signed-in') return 'login'
  if (lowered === 'owner' || lowered === 'private' || lowered === 'self') return 'owner'
  return undefined
}

/** A PAT is an opaque token; OAuth access tokens are JWTs and contain dots. */
export function looksLikePat(token: string): boolean {
  return token.includes('.') === false
}

/** Reject a token that cannot be a PAT or an OAuth access token. */
export function assertTokenShape(token: string): string {
  const trimmed = token.trim()
  if (trimmed.length < 20) throw new Error('a cnblogs personal access token is at least 20 characters long')
  if (/\s/.test(trimmed)) throw new Error('the token must not contain whitespace')
  if (trimmed.length > 4096) throw new Error('the token is too long to be a cnblogs token')
  return trimmed
}
