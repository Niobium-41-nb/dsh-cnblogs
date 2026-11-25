---
title: 让 Agent 自己发博客：dsh-cnblogs 插件（DeepSeek Harness）
tags: [dsh, deepseek-harness, cnblogs, 插件]
status: publish
access: public
slug: dsh-cnblogs
summary: 一个把「写好的 Markdown 发到博客园」变成 Agent 一次工具调用的插件：8 个工具、图片自动转存、保存后读回校验，外加一次真机接口踩坑记录。
---

每次写完一篇 Markdown，要发到博客园，总得走一遍：打开后台 → 新建 → 粘贴正文 → 一张张传图 → 调分类和标签 → 点发布。

这些步骤没有一步需要脑子，但每一步都不适合交给「再打开一个编辑器」来做。既然 DeepSeek Harness（下称 DSH）里的 Agent 已经能读文件、跑命令、调工具，为什么不让它顺手把文章发出去？

`dsh-cnblogs` 就是为此写的一个 DSH 插件。它向模型注册 8 个 `cnblogs_*` 工具，让「把这篇文件发到博客园」变成一次工具调用。**你现在读到的这篇文章，就是用它自己发出来的。**

## 它做了什么

| 工具 | 作用 |
|---|---|
| `cnblogs_account` | 校验令牌并报告账号；保存/清除令牌 |
| `cnblogs_list_posts` | 一页博文（id、状态、时间、阅读数），可按标题搜索、按分类过滤 |
| `cnblogs_get_post` | 读一篇的 Markdown 正文与元数据，超长截断并说明 |
| `cnblogs_save_post` | 按文件或内联正文新建/更新；自动转存图片；保存后**读回校验** |
| `cnblogs_delete_posts` | 按 id 删除，逐个报告失败原因 |
| `cnblogs_upload_image` | 单张图（本地文件 / 网络 URL / Base64）→ 图床 URL |
| `cnblogs_taxonomy` | 列分类（含 id 与篇数）、列标签、新建分类、删除分类 |
| `cnblogs_ings` | 闪存：列表、发布、评论 |

一次发布大致是这样的：

```text
cnblogs_save_post({ file: "posts/dsh-cnblogs.md" })
  → 读文件、拆 front matter
  → 取新博文模板（或已有博文）
  → 逐张上传文中引用的本地图片，改写链接
  → POST /posts，拿到 id 与 URL
  → GET /posts/{id} 读回，比对标题与正文
  → created post #xxx，state: published，verified: ok
```

## 为什么不直接驱动 VS Code 扩展

博客园官方有一个很好用的 VS Code 扩展 [`cnblogs/vscode-cnb`](https://github.com/cnblogs/vscode-cnb)：侧边栏发布、图床上传、分类管理、导出 PDF 都有。但它是**编辑器集成**——围绕工作空间、webview、剪贴板、本地 Chromium 设计的，而 Agent 没有编辑器会话，也没有剪贴板。

所以这个插件没有去「驱动扩展」，而是直接打同一套 HTTP 接口：

- `write.cnblogs.com/api`：博文、分类、标签、图片上传；
- `api.cnblogs.com/api`：账号信息、闪存；
- 认证：`Authorization: Bearer <令牌>`，个人访问令牌（PAT）再带一个 `Authorization-Type: pat`。

接口形状是照着扩展 1.8.58 的源码逐个核对出来的（它的请求层在 Rust/WASM 里），没有猜。好处是「编辑器发的」和「Agent 发的」就是同一个博客、同一批博文，不存在两套数据。

## 三个值得说的设计

### 1. 同一个文件再保存 = 更新，而不是重复发布

扩展里叫「关联博文」：本地文件和一个 postId 绑定。插件把这份映射记在自己的状态文件里（`<DSH_HOME>/dsh-cnblogs/state.json`，权限 0600），于是：

```text
cnblogs_save_post({ file: "posts/dsh-cnblogs.md" })   # 第一次：created
cnblogs_save_post({ file: "posts/dsh-cnblogs.md" })   # 第二次：updated，同一个 postId
```

改完稿子再发一次就行，不会在后台攒出一堆同名草稿。换机器或换目录时，用 `postId` 显式指定。

### 2. 保存后读回校验

扩展只相信 `POST /posts` 的响应。插件多做一步：保存完立刻 `GET /posts/{id}`，比对标题与正文（忽略行尾空白与 CRLF），结果里给：

- `verified: ok`：博客上存的就是你发的那份；
- `title-mismatch` / `body-mismatch`：接口说成功，但存下来的不是这份，会附一条 warning。

「接口返回 200」和「读者看到的是这篇」不是一回事，尤其当正文被截断、图片链接被改写的时候。

### 3. 图片自动转存

Markdown 里写 `![shot](./images/a.png)` 或 Base64 图片，直接发到博客园是坏的。插件会：

- 相对/绝对本地路径 → 上传到博客园图床，改写为图床 URL；
- `data:image/...` → 解码上传，替换；
- 已经在 `*.cnblogs.com` 上的图片 → 不动；
- 第三方 HTTP 图片 → **默认不动**（转存等于把别人的图传到你博客，得显式打开 `extractWebImages`）；
- 单张失败不影响整篇保存，会写进 `imagesFailed` 并留原链接。

## 一个文件长什么样

文章源文件可以带 YAML front matter，插件读完把它从正文里剥掉（`---` 在博客上会渲染成一条横线）：

```markdown
---
title: 让 Agent 自己发博客：dsh-cnblogs 插件
tags: [dsh, deepseek-harness, cnblogs, 插件]
categories:
  - 开发工具
status: publish
access: public
slug: dsh-cnblogs
summary: 一段摘要
---

正文……
```

支持 `title`、`tags`、`categories`、`status`（`draft` / `publish`）、`access`（`public` / `login` / `owner`）、`slug`、`summary`、`pinned`、`comments`、`postId`。工具参数优先于 front matter；新博文默认是**草稿**，要公开得显式写 `status: publish`。

## 怎么用

安装（插件是本地目录，尚未发布到 npm）：

```bash
# 从插件目录构建
node node_modules/typescript/bin/tsc -b tsconfig.json
node node_modules/tsdown/dist/run.mjs
```

然后在 DSH 里 **Settings → Plugins → Add plugin** 选择插件目录，或把目录装进 profile。装好后模型会多出 8 个 `cnblogs_*` 工具。

令牌在 <https://account.cnblogs.com/settings/tokens> 创建，三选一：

1. 环境变量 `CNBLOGS_PAT`；
2. 令牌文件 `<DSH_HOME>/dsh-cnblogs/token`（一行；插件启动时会生成只有注释的模板，写进去就生效，**不用重启**）；
3. 配置里的 `token` —— 不推荐，配置文件会被同步、被看到。

不建议把令牌贴进对话：工具参数会进会话日志。

## 一次真机踩坑：分类接口是对象不是数组

写这个插件时，博文、标签、图片、闪存这几个接口的返回形状都对上了，唯独分类踩了坑：我按「数组」写了解析，本地假后端也返回数组，测试全绿。真机一跑：

```text
categories   HTTP 200  object{categories:array(2), parent}
```

真实响应是 `{ categories: [...], parent }`，官方扩展也是解构 `{ categories }` 的。结果是 `list-categories` 永远说「还没有分类」，按名字选分类会直接报「未知分类」。

修法很简单（解包 `categories` / `items` / `data` 三种包装，并且裸数组也接受），但教训值得记：**假后端必须长得像真的**。顺手加了一个只读诊断脚本 `scripts/probe-shapes.mjs`，只打印 HTTP 状态与结构（键名、长度），不打印值，后端一改形状就能立刻发现：

```text
users          HTTP 200  object{UserId,SpaceUserID,AccountId,BlogId,DisplayName,...,BlogApp,...}
posts/list     HTTP 200  object{postList:array(1),postsCount,pageIndex,pageSize,...}
posts/-1       HTTP 200  object{blogPost,myConfig}
categories     HTTP 200  object{categories:array(2),parent}
tags           HTTP 200  array(1)
statuses/@4    HTTP 200  array(0)
```

## 验证与边界

- 单元 + 装配测试 **118 + 68 项**，另有 10 项针对构建产物的冒烟检查：front matter、图片发现与改写、代码块里的示例图片不误传、分类解析、令牌四种来源、状态文件、新建/更新/图片转存/删除/失败路径，并且逐一校验每个工具的返回值与它声明的输出结构一致。
- 装配测试用的是真 `apply()` + 内存假后端，不走网络；真机侧用只读脚本 `tests/live.check.mjs` 验证账号、博文、分类、标签四个读接口。
- 写路径的真机验证：新建与更新就是这篇文章的两次发布——第一次 `created`，改完稿再发是 `updated`，两次都 `verified: ok`。删除没有在这篇文章上演练，不拿读者能看到的文章做实验。

明确不做的事：PDF 导出（需要本地 Chromium）、博客备份导出/下载（服务端长任务 + zip）、剪贴板上传（工具参数边界之外）、浏览器 OAuth 登录（Agent 没有浏览器会话，用 PAT 代替）。

## 结语

这个插件的价值不在于「又一个发布工具」，而在于把一件零碎的手工作业变成一句可验证的操作：Agent 发完会告诉你 postId、URL、状态，以及「读回来是不是这份」。

目前它是本机插件，还没发布到 npm 或 GitHub；如果你也想让 Agent 接管这套流程，按上面的步骤把它装进自己的 profile 就行。踩到的那个分类接口的坑已经修好并写进了测试——下次它不会再悄悄返回空列表。
