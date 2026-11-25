# dsh-cnblogs

[![check](https://github.com/Niobium-41-nb/dsh-cnblogs/actions/workflows/check.yml/badge.svg)](https://github.com/Niobium-41-nb/dsh-cnblogs/actions/workflows/check.yml) [![npm](https://img.shields.io/npm/v/dsh-cnblogs)](https://www.npmjs.com/package/dsh-cnblogs) [![license](https://img.shields.io/github/license/Niobium-41-nb/dsh-cnblogs)](https://github.com/Niobium-41-nb/dsh-cnblogs/blob/master/LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets the agent publish to
**博客园 (cnblogs)** on its own: list and read posts, create or update one from a markdown file, upload the
images the markdown references, and manage categories, tags and 闪存. It registers eight `cnblogs_*` tools,
starts no daemon, listens on no port, and keeps the personal access token out of the configuration.

It talks to the same HTTP endpoints as the official [`cnblogs/vscode-cnb`](https://github.com/cnblogs/vscode-cnb)
extension (`write.cnblogs.com/api` for posts, `api.cnblogs.com/api` for the account and 闪存), so a blog driven
from the editor and a blog driven by the agent are the same blog.

The published write-up (in Chinese, written and published by this plugin):
[让 Agent 自己发博客：dsh-cnblogs 插件](https://www.cnblogs.com/vanadium-23/p/23781111/dsh-cnblogs).

Install into a profile — `dsh.bundle.patch` inserts its row, so no hand-written profile patch is needed:

```bash
dsh plugin --profile web add dsh-cnblogs
```

> 中文完整说明见下方 [中文文档](#中文文档)。

## Tools

| Tool | What it does |
|---|---|
| `cnblogs_account` | `status` verifies the token and reports the account; `save` stores a token after verifying it; `clear` forgets it |
| `cnblogs_list_posts` | One page of posts with ids, state, dates and view counts; optional title search and category filter |
| `cnblogs_get_post` | One post as markdown plus tags, categories, state and URL; the body is capped by `maxBodyChars` |
| `cnblogs_save_post` | Create or update a post from `file` or inline `body`; rehosts images; reads the post back and reports `verified` |
| `cnblogs_delete_posts` | Deletes posts by id and reports per-id failures |
| `cnblogs_upload_image` | Uploads one local file, remote URL or data URL and returns the hosted URL |
| `cnblogs_taxonomy` | Lists categories (ids, counts) and tags; creates and deletes categories |
| `cnblogs_ings` | Lists, publishes and comments on 闪存 |

`cnblogs_save_post` is the one that replaces the editor workflow: pass a local markdown file and the post id
recorded for that file is reused, so saving the same file again updates the published post instead of creating
a duplicate.

## Token

Create a personal access token at <https://account.cnblogs.com/settings/tokens>, then pick one source:

1. **Environment** — `CNBLOGS_PAT` in the environment of the harness process.
2. **Token file** — `<DSH_HOME>/dsh-cnblogs/token`, one token per line. The plugin creates this file on start as a
   comment-only template (an untouched template still means "no token"), and
   `node --experimental-strip-types scripts/init-token.mjs` creates it on demand. The token is read on every call, so
   writing the file is enough — no restart.
3. **Inline configuration** — `token` in the plugin's `cordis.yml` row. Discouraged: configuration files get
   synced and shared.

`cnblogs_account` action `save` also works, but a token passed as a tool argument is recorded in the session
log, so prefer the environment or the file. When the harness credential service is available the plugin stores
the token as the `CNBLOGS_PAT` credential record instead of a file; the file is the fallback.

## Front matter

A post file may open with a YAML block. The plugin reads it, removes it from the uploaded markdown (a `---`
rule renders as a horizontal line), and lets explicit tool arguments win over it. `keepFrontMatter: true` in the
configuration keeps the block.

```markdown
---
title: 用 DeepSeek Harness 发布博客园
tags: [dsh, cnblogs]
categories:
  - 后端
status: publish
slug: publish-with-dsh
summary: 一段摘要
---

正文……
```

Recognized keys: `title`, `tags`, `categories`, `status` (`draft` / `publish`), `access` (`public` / `login` /
`owner`), `slug`, `summary`, `pinned`, `comments`, `postId`.

## Images

`cnblogs_save_post` scans markdown images and `<img src>` tags:

- relative and absolute local paths are uploaded, then rewritten to the blog's image host;
- base64 `data:image/...` URLs are uploaded and replaced;
- images already on a `*.cnblogs.com` host are left alone;
- third-party HTTP images are left alone unless `extractWebImages` is on (rehosting them uploads someone
  else's image to the blog);
- an image that cannot be uploaded is reported in `imagesFailed` and left unchanged, so the post is still saved.

`cnblogs_upload_image` handles the case where the URL itself is needed.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Mount the tool set |
| `token` / `tokenFile` | `''` / `<stateDir>/token` | Inline token, or the file to read |
| `stateDir` | `<DSH_HOME>/dsh-cnblogs` | File → post mappings, cached account, token file |
| `blogBackend` / `openapi` | cnblogs URLs | Base URLs; override only for a compatible host |
| `timeoutMs` | `30000` | Per-request deadline |
| `maxBodyChars` | `200000` | Largest body accepted; also the default read cap |
| `maxUploadBytes` | `10485760` | Largest single image |
| `extractImages` / `extractWebImages` | `true` / `false` | Rehost local and data URLs / also third-party URLs |
| `keepFrontMatter` | `false` | Keep the YAML block in the published markdown |
| `defaultStatus` / `defaultAccess` | `draft` / `public` | Applied to a **new** post when the caller is silent |
| `promptSection` | `true` | Add the short usage section to the system prompt |

## What it does not do

These are editor-side features of `vscode-cnb` that do not belong in an agent tool set:

- PDF export — needs a local Chromium; use the harness's browser tooling instead.
- Blog backup export/download — a long-running server job with a zip download.
- Clipboard image upload — a tool argument is the boundary; pass a file or a data URL.
- Workspace activation — there is no editor workspace; every tool acts on an explicit path or id.
- Browser OAuth login — the agent has no browser session; a personal access token plays that role.

## Development

```bash
pnpm install --ignore-scripts
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -b tsconfig.json
node node_modules/tsdown/dist/run.mjs
node --experimental-strip-types tests/unit.test.mjs       # 106 checks
node --experimental-strip-types tests/plugin.test.mjs     # 66 checks
node tests/bundle.smoke.mjs                               # 10 checks, needs a build
node --experimental-strip-types tests/live.check.mjs      # read-only live check, needs a token
```

The plugin test mounts the real `apply()` against a fake Cordis context and an in-memory cnblogs backend, so
it covers request building, the file mapping, image rewriting, failure paths and every tool's output schema
without touching the network. **A live-endpoint run needs your own token**; until then the request shapes are
verified only against the endpoints read from `vscode-cnb` 1.8.58 and the fake backend.

---

## 中文文档

### 它是什么

`dsh-cnblogs` 让 DeepSeek Harness 的 Agent **自己把文章发到博客园**：列博文、读博文、按本地 Markdown
新建或更新博文、把文中引用的图片转存到博客园图床、管理分类/标签、看和发闪存。

推介文章（由本插件自己写出并发布）：
[让 Agent 自己发博客：dsh-cnblogs 插件](https://www.cnblogs.com/vanadium-23/p/23781111/dsh-cnblogs)。

它调用的是博客园官方 VS Code 扩展 [`cnblogs/vscode-cnb`](https://github.com/cnblogs/vscode-cnb) 的同一套
接口，所以「编辑器发的」和「Agent 发的」是同一个博客、同一批博文。

八个工具：

| 工具 | 作用 |
|---|---|
| `cnblogs_account` | 验证令牌并报告账号；保存令牌；清除令牌 |
| `cnblogs_list_posts` | 一页博文（id、状态、时间、阅读数），可按标题搜索、按分类过滤 |
| `cnblogs_get_post` | 读一篇博文的 Markdown 正文与元数据（正文超过上限会截断并说明） |
| `cnblogs_save_post` | 按文件或内联正文新建/更新；自动转存图片；保存后**读回校验**并报告 `verified` |
| `cnblogs_delete_posts` | 按 id 删除，逐个报告失败原因 |
| `cnblogs_upload_image` | 上传单张图片（本地文件 / 网络 URL / Base64），返回图床 URL |
| `cnblogs_taxonomy` | 列分类（含 id 与篇数）、列标签、新建分类、删除分类 |
| `cnblogs_ings` | 闪存：列表、发布、评论 |

### 安装

**从 npm 装（推荐）** —— `dsh.bundle.patch` 会自己把这行 `insert` 挂进 `dsh.profile.bundles`：

```bash
DSH="<HARNESS>/resources/runtime/cli/bin/dsh.cmd"
"$DSH" plugin --profile web add dsh-cnblogs
```

**从源码装**（改代码时用）—— pnpm 的 `file:` 依赖按内容快照安装，改完要 `remove` 再 `add`：

```bash
cd dsh-cnblogs
pnpm install --ignore-scripts
pnpm build
"$DSH" plugin --profile web add file:<PLUGINS>/dsh-cnblogs
```

装好后模型会多出 8 个 `cnblogs_*` 工具（新进程生效）。

### 令牌怎么给

在 <https://account.cnblogs.com/settings/tokens> 创建个人访问令牌（PAT），然后三选一：

1. **环境变量**：harness 进程的 `CNBLOGS_PAT`；
2. **令牌文件**：`<DSH_HOME>/dsh-cnblogs/token`，一行一个令牌。插件启动时会把这个文件**建成一个只有注释的模板**
   （模板没填就等于「还没有令牌」）；文件不存在也可以手动生成：`node --experimental-strip-types scripts/init-token.mjs`。
   令牌是**每次调用现读**的，所以写进文件就生效，不用重启；
3. **配置里的 `token`**：不推荐，配置文件会被同步、被看到。

不建议让 Agent 用「把令牌贴进对话」的方式保存：工具参数会进会话日志。`cnblogs_account` 的 `save`
只是给「用户已经主动贴了」的情况兜底。

### 一次发布长什么样

```
cnblogs_save_post({ file: "E:/blog/我的文章.md" })
  → 读文件、拆 front matter、取模板或已有博文
  → 找到相对路径图片，逐张上传到博客园并改写链接
  → POST /posts，拿到 id 与 URL
  → GET /posts/{id} 读回，比较标题与正文
  → 结果：created post #123、state、verified: ok、warnings
```

同一个文件再存一次就是**更新**，不是新建：插件把 `文件 → 博文 id` 记在
`<DSH_HOME>/dsh-cnblogs/state.json` 里（权限 0600）。换机器或换目录时用 `postId` 显式指定。

### 关于「已验证」

- **单元 + 装配测试共 172 项**（106 + 66），覆盖 front matter、图片发现与改写、分类解析、令牌来源、
  令牌模板、状态文件、新建/更新、图片转存、删除、失败路径，并逐一校验每个工具的输出结构与其声明一致；
  另有 10 项针对**构建产物** `lib/index.js` 的冒烟检查。
- **真实接口尚未验证**：那需要一个真实的 PAT。请求的形状来自官方扩展 1.8.58 的源码
  （`rs/src/cnb/**`、`src/service/**`），本地用一个内存假后端跑通了全流程。两个接口主机已确认可达且
  未认证时返回 401（`write.cnblogs.com/api/posts/list`、`api.cnblogs.com/api/users`）。
- 写好令牌后，用**只读**检查确认：`node --experimental-strip-types tests/live.check.mjs`
  —— 它只调用「查账号」和「列 3 篇博文」，不写、不删、不发。

### 明确不做的事

PDF 导出（需要本地 Chromium）、博客备份导出/下载（服务端长任务 + zip）、剪贴板上传（工具参数边界之外）、
工作空间自动激活（没有编辑器工作空间）、浏览器 OAuth 登录（Agent 没有浏览器会话，用 PAT 代替）。
