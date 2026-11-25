/**
 * dsh-cnblogs — host plugin.
 *
 * Publishes the agent's markdown to 博客园 through the same HTTP endpoints the
 * official VS Code extension uses, so "write the post and put it on the blog"
 * becomes one tool call instead of a manual editor workflow. Host-only: there is
 * no browser half, no editor integration, and no secret in the configuration.
 * @module dsh-cnblogs
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FetchLike } from './api.ts'
import { AuthStore, ensureTokenTemplate } from './auth.ts'
import { Config as ConfigSchema, resolveConfig, resolveStatePath, resolveTokenPath } from './config.ts'
import { StateStore } from './store.ts'
import { registerTools } from './tools.ts'
import type { Config as ConfigShape } from './types.ts'

export type { Config as CnblogsConfig } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-cnblogs'

/** The base bundle's tool registry is the only required service. */
export const inject = ['tools']

/** Schemastery configuration, surfaced in `cordis.yml`. */
export const Config = ConfigSchema

/** Prompt section name; registered once per boot. */
const USAGE_SECTION = 'dsh-cnblogs:usage'

/** Order just after the harness's own tool guidance. */
const USAGE_SECTION_ORDER = 10_070

/** Structural view of the optional system-prompt service. */
interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): () => void
}

/** Usage text shown to the model once per boot. */
export const USAGE_TEXT = [
  '## Blog posts (博客园)',
  '',
  '`cnblogs_*` tools read and write the user\'s cnblogs blog. Start with `cnblogs_account` action `status`: when no token is '
  + 'configured it reports the environment variable and file path to fill in, and it never echoes the token.',
  '',
  'Use `cnblogs_list_posts` and `cnblogs_get_post` to find and read posts, and `cnblogs_save_post` to create or update one. '
  + 'Passing `file` reuses the post id recorded for that file, so saving the same file again updates that post instead of '
  + 'duplicating it. Local and data-URL images are uploaded and rewritten automatically; third-party images are kept unless '
  + 'the plugin is configured to rehost them.',
  '',
  'A new post is a draft unless `status` is `publish`. Confirm with the user before making a post public or deleting one, and '
  + 'check the `verified` field of a save: `body-mismatch` means the blog stored something other than the markdown you sent.',
].join('\n')

/** Optional test seam; production never supplies it. */
export interface ApplyDependencies {
  fetchFn?: FetchLike
}

/** Mount the tool set and the optional prompt section. */
export function apply(ctx: Context, rawConfig?: Partial<ConfigShape>, deps?: ApplyDependencies): void {
  const config = resolveConfig(rawConfig)
  if (config.enabled === false) {
    process.stderr.write('[dsh-cnblogs] disabled by configuration\n')
    return
  }

  const store = new StateStore(resolveStatePath(config))
  const auth = new AuthStore({ config, ctx, env: process.env })
  const tokenPath = resolveTokenPath(config)
  const template = ensureTokenTemplate(tokenPath)
  process.stderr.write(`[dsh-cnblogs] token file: ${tokenPath} (${template})\n`)

  registerTools(ctx, {
    config,
    store,
    auth,
    ...(deps?.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
  })

  if (!config.promptSection || typeof ctx.inject !== 'function') return
  ctx.inject(['systemPrompt'], (scope) => {
    const systemPrompt = (scope as unknown as { systemPrompt?: SystemPromptLike }).systemPrompt
    if (systemPrompt === undefined) return
    systemPrompt.section({ name: USAGE_SECTION, order: USAGE_SECTION_ORDER, text: USAGE_TEXT })
  })
}
