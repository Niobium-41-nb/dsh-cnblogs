/**
 * Token resolution and storage.
 *
 * Four sources are tried in order — inline configuration, the harness credential
 * seam, the environment, then a private token file. The file is the fallback that
 * needs no daemon and no configuration edit, which is what makes "log in" a
 * one-line action for a human without ever pasting a secret into a conversation.
 * @module dsh-cnblogs/auth
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertTokenShape, resolveTokenPath } from './config.ts'
import type { Config } from './types.ts'

/** Where a resolved token came from. */
export type TokenSource = 'config' | 'credential' | 'env' | 'file'

/** A token plus its provenance, never logged as a value. */
export interface ResolvedToken {
  token: string
  source: TokenSource
}

/** The credential-key this plugin stores its PAT under. */
export const CREDENTIAL_REF = 'CNBLOGS_PAT'

/** Environment variables checked before the token file. */
export const ENV_NAMES = ['CNBLOGS_PAT', 'CNBLOGS_TOKEN'] as const

/** The slice of `ctx.credentials` this plugin uses (duck-typed, so it stays optional). */
interface CredentialsLike {
  resolve(ref: string): Promise<{ value?: unknown } | undefined>
  set?(ref: string, value: string): Promise<void>
  unset?(ref: string): Promise<void>
}

/** The slice of the Cordis context needed for credentials. */
export interface AuthContextLike {
  get(name: string): unknown
}

export interface AuthOptions {
  config: Config
  ctx?: AuthContextLike
  env?: NodeJS.ProcessEnv
}

/** Read the first meaningful line of a token file. */
export function readTokenFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    return trimmed
  }
  return undefined
}

/** Comment-only skeleton written when no token file exists yet. */
export const TOKEN_TEMPLATE = [
  '# 博客园个人访问令牌（cnblogs personal access token）',
  '#',
  '# 用法：把令牌单独写在新的一行、保存即可。下一次 cnblogs_account 的 status 动作就会读到它，',
  '# 不需要重启 harness。这一行以下全是注释，所以当前这个文件等于「还没有令牌」。',
  '#',
  '# 令牌在这里创建：https://account.cnblogs.com/settings/tokens',
  '# 这个文件只留在本机；不要把它提交进任何仓库，也不要贴进对话。',
  '#',
].join('\n')

/**
 * Make the reported token path real, so "write it to that file" is an action a
 * person can take rather than a path that does not exist yet. Never overwrites an
 * existing file, and an untouched template still resolves to "no token".
 */
export function ensureTokenTemplate(path: string): 'created' | 'present' | 'skipped' {
  if (existsSync(path)) return 'present'
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${TOKEN_TEMPLATE}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(path, 0o600)
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
    return 'created'
  } catch {
    return 'skipped'
  }
}

/** Token resolution and persistence for one mount. */
export class AuthStore {
  readonly config: Config
  private readonly ctx: AuthContextLike | undefined
  private readonly env: NodeJS.ProcessEnv

  constructor(options: AuthOptions) {
    this.config = options.config
    this.ctx = options.ctx
    this.env = options.env ?? process.env
  }

  /** The token file this plugin would read or write. */
  tokenPath(): string {
    return resolveTokenPath(this.config, this.env)
  }

  private credentials(): CredentialsLike | undefined {
    if (this.ctx === undefined) return undefined
    try {
      const service = this.ctx.get('credentials')
      if (service === null || service === undefined) return undefined
      if (typeof (service as CredentialsLike).resolve !== 'function') return undefined
      return service as CredentialsLike
    } catch {
      return undefined
    }
  }

  /** Resolve the PAT, trying each source once. */
  async resolve(): Promise<ResolvedToken | undefined> {
    const inline = this.config.token.trim()
    if (inline.length > 0) return { token: inline, source: 'config' }

    const credentials = this.credentials()
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(CREDENTIAL_REF)
        const value = hit?.value
        if (typeof value === 'string' && value.trim().length > 0) {
          return { token: value.trim(), source: 'credential' }
        }
      } catch {
        // A missing or unavailable credential store is not an error: fall through.
      }
    }

    for (const name of ENV_NAMES) {
      const value = this.env[name]
      if (value !== undefined && value.trim().length > 0) return { token: value.trim(), source: 'env' }
    }

    const fromFile = readTokenFile(this.tokenPath())
    if (fromFile !== undefined) return { token: fromFile, source: 'file' }
    return undefined
  }

  /** Persist a validated token; the credential seam wins over the file. */
  async save(token: string): Promise<TokenSource> {
    const value = assertTokenShape(token)
    const credentials = this.credentials()
    if (credentials !== undefined && typeof credentials.set === 'function') {
      try {
        await credentials.set(CREDENTIAL_REF, value)
        return 'credential'
      } catch {
        // Fall back to the private file when the seam refuses the write.
      }
    }
    const path = this.tokenPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${value}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(path, 0o600)
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
    return 'file'
  }

  /**
   * Remove every stored copy.
   *
   * `hadToken` separates "removed a token" from "removed the empty template", so
   * the caller can describe what actually happened instead of claiming a secret
   * was deleted when none was there.
   */
  async clear(): Promise<{ credential: boolean; tokenFile: boolean; hadToken: boolean }> {
    let credential = false
    const credentials = this.credentials()
    if (credentials !== undefined && typeof credentials.unset === 'function') {
      try {
        await credentials.unset(CREDENTIAL_REF)
        credential = true
      } catch {
        // Ignore: the file may still hold the token.
      }
    }
    const path = this.tokenPath()
    const hadToken = readTokenFile(path) !== undefined
    let tokenFile = false
    if (existsSync(path)) {
      rmSync(path, { force: true })
      tokenFile = true
    }
    return { credential, tokenFile, hadToken }
  }
}
