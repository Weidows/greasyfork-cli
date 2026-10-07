# gf — Greasy Fork CLI

[English](README.md) | **简体中文**

<img src="https://raw.githubusercontent.com/Weidows/greasyfork-cli/main/assets/header.webp" alt="gf —— Greasy Fork 的叉子徽章与脚本列表，取站点枣红与深绿配色" width="100%">

**在终端里搜索、查看、下载 [Greasy Fork](https://greasyfork.org) 用户脚本。**<br>
以 [`@greasyfork/cli`](https://www.npmjs.com/package/@greasyfork/cli) 发布 · 零运行时依赖 · 同时提供带类型的库和 `gf` 命令。

[![npm](https://img.shields.io/npm/v/%40greasyfork%2Fcli?style=flat-square&label=npm)](https://www.npmjs.com/package/@greasyfork/cli)
[![release](https://img.shields.io/github/v/release/Weidows/greasyfork-cli?sort=semver&style=flat-square)](https://github.com/Weidows/greasyfork-cli/releases/latest)
[![license](https://img.shields.io/github/license/Weidows/greasyfork-cli?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen?style=flat-square)](package.json)
[![release workflow](https://github.com/Weidows/greasyfork-cli/actions/workflows/release.yml/badge.svg)](https://github.com/Weidows/greasyfork-cli/actions/workflows/release.yml)
[![publish workflow](https://github.com/Weidows/greasyfork-cli/actions/workflows/publish-npm.yml/badge.svg)](https://github.com/Weidows/greasyfork-cli/actions/workflows/publish-npm.yml)

> **非官方项目。** 社区客户端，与 Greasy Fork 官方及其维护者无关，也未获其背书。它读取站点公开的 JSON 接口；而 `login` / `publish` 是驱动站点自身的 HTML 表单 —— 那不属于任何成文 API，随时可能改版失效，把它当便利工具而非稳定契约。
>
> **不支持：** 评分 / 评论 / 收藏 —— 刻意不做。
>
> `publish` 是**对你账号的真实公开写入**，且从不自动执行：`--dry-run` 会先打印将要提交的内容；想试手请用一次性小号 + unlisted（不公开）脚本。

## 安装

```bash
npm i -g @greasyfork/cli        # 不安装也能用：npx @greasyfork/cli search bilibili
```

需要 Node 18+，别无其他 —— `npm ls @greasyfork/cli` 只有它自己。**推荐走这条**：包体约 50 KB，因为 Node 本来就在你机器上。

机器上没有 Node？从 [Releases](https://github.com/Weidows/greasyfork-cli/releases) 下预编译二进制 —— 但请先看[为什么它们有 60–95 MB](#为什么二进制有-6095-mb)：

| 平台 | 文件 |
|---|---|
| Linux x64 | `gf-linux-x64.tar.gz` |
| Linux arm64 | `gf-linux-arm64.tar.gz` |
| macOS Intel | `gf-darwin-x64.tar.gz` |
| macOS Apple Silicon | `gf-darwin-arm64.tar.gz` |
| Windows x64 | `gf-windows-x64.zip` |

```bash
tar -xzf gf-linux-x64.tar.gz && ./gf search bilibili
```

同目录下有 `SHA256SUMS.txt` 可校验。macOS 上若**用浏览器下载**（会带上隔离标记）需先解除 —— 二进制已做 ad-hoc 签名，但那个属性仍要手动移除：

```bash
xattr -d com.apple.quarantine gf-darwin-arm64
```

## 在国内 / 走代理？先读这段

国内直连 Greasy Fork 是不通的，而 `node:https` 和 `fetch` **都不认 `HTTP_PROXY` / `HTTPS_PROXY`**。所以 `gf` 不依赖它们，按以下顺序自动探测：

1. `GREASYFORK_CLI_PROXY`、`GF_PROXY`、`https_proxy`、`HTTPS_PROXY`、`http_proxy`、`HTTP_PROXY`
2. `git config --global https.proxy` —— 很多机器只给 git 配了代理

探测到就自动使用，**无需任何配置**。想显式指定：

```bash
gf --proxy http://127.0.0.1:7890 search bilibili
gf --no-proxy search bilibili          # 强制直连
```

只支持 `http://` / `https://` 代理；`socks5://` 会明确报错，而不是静默失败。

## 用法

```bash
gf search bilibili                # 搜索
gf search --sort created -n 10    # 最新发布；也可 updated / installs / rating / name
gf search --site bilibili.com     # 只搜某个站点的脚本
gf --locale zh-CN search 视频     # 中文站点
gf info 405130                    # 详情
gf download 405130 -o ./scripts --with-meta
gf cat 405130 | less              # 看源码
gf versions 405130                # 历史版本
gf user 584991-windrunnermax      # 某作者的全部脚本
gf sites -n 20                    # 各站点脚本数量排行
gf open 405130 --launch           # 打开脚本页
gf check ./scripts                # 检查本地脚本是否过时

gf login                          # 登录（输入密码时以 *** 回显）
gf login --cookie -               # 或从浏览器粘会话 cookie（读 stdin）
gf whoami                         # 当前存的会话还有效吗？
gf publish my.user.js             # 发布或更新脚本
gf publish my.user.js --dry-run   # 只抓表单、拼载荷，不提交任何东西
gf logout                         # 只清本地会话（不动浏览器）
gf logout --server                # 连服务器一起登出，浏览器也会掉线
```

`<script>` 参数接受 `405130`、`405130-slug` 或完整 URL 三种写法。

| 命令 | 别名 | 作用 |
|---|---|---|
| `search [关键词]` | `s` | 搜索；不带关键词 = 总榜 |
| `info <脚本>` | `show` | 作者、版本、许可、安装量、评分、URL |
| `download <脚本>` | `dl` | 保存 `.user.js`（`--with-meta` 连 `.meta.js` 一起） |
| `cat <脚本>` | | 把源码打到 stdout，方便管道 |
| `versions <脚本>` | | 所有历史版本 |
| `user <id\|用户名>` | | 某作者发布的全部脚本 |
| `sites` | | 各站点脚本数量 |
| `open <脚本>` | | 打印脚本页 URL（`--launch` 直接打开） |
| `check <路径...>` | | 用 `@updateURL` 比对本地脚本是否过时 |
| `login` | | 登录并保存会话 cookie |
| `logout` | | 清除已保存的会话 |
| `whoami` | | 显示当前登录账号 |
| `publish <文件>` | `push` | 发布新脚本，或更新已有脚本 |

### 发布

```bash
gf login                                  # 只需一次；cookie 能撑几个月
gf publish my.user.js                     # 新脚本；若 @downloadURL 指向已有脚本则更新它
gf publish my.user.js --id 405130         # 强制指定目标脚本 id
gf publish my.user.js --dry-run           # 抓表单 + 拼载荷，不发 POST
gf publish my.user.js --type unlisted     # public（默认）| unlisted | library
gf publish my.user.js --changelog "修复x" # 更新说明，会显示在脚本页
gf publish my.user.js --force             # 确认站点的警告并重提
```

`gf publish` 会先读文件里的 `@name`、`@version`、`@match`/`@include`，凡是站点同样会拒的就**在本地先拦下** —— 没升 `@version`、没有 `@match`、完全没有 meta 块。然后：

1. 抓发布表单（新建或更新），从**页面里取当次有效的 CSRF token**（不缓存、不硬编码）；
2. POST 代码到 `/<locale>/script_versions`（新建）或 `/<locale>/scripts/<id>/versions`（更新）；
3. 用**重定向目标**判定成败 —— 跳到 `/scripts/<id>-<slug>` 才算发布成功；返回 200 且重渲染表单就是被拒，并把服务端自己的报错原文打出来。

站点的警告（"version not incremented"、"no namespace" 等）**只报告、不吞掉** —— 那是作者本人该做的确认；只有 `--force` 会勾选它们，别的地方都不会。

想安全试手：用一次性小号 + `unlisted` 脚本。这是对真实账号的真实写入。

密码**不作为命令行参数**（会进 shell history，且在 Windows 上还会出现在进程列表里）。它来自 `GF_PASSWORD` 环境变量，或一个把你输入的字符显示成 `*` 的提示（这样你能看到按键确实进去了，退格会缩短掩码）。实现是 `readline` 的 raw mode 配一个丢弃写入的 sink —— 值不进终端，但字符数照数。（最初用的是 PowerShell `Read-Host -AsSecureString`，但它**在 Node 派生的子进程里根本不可用**：带 `-NonInteractive` 时 PowerShell 拒绝弹提示，去掉该标志后子进程又拿不到控制台，于是没问密码就非零退出。两种方式都实测过。）

```bash
gf login --email me@example.com      # 交互式，密码以 *** 回显
gf login --otp 123456                # 账号开了 2FA 时
GF_PASSWORD=… gf login               # 给脚本用；注意 shell history
```

**粘贴会话 cookie。** 这是**用 GitHub / GitLab / Google 注册的账号唯一的进路** —— 这类账号可能**完全没有密码**（站点提供「移除密码」，且在设置「安全登录」前不允许发布脚本）。如果你不想把密码交给 CLI，这也是更实际的选择。

```bash
# 在已登录的浏览器标签页：DevTools → Application → Cookies → greasyfork.org
# 复制 _greasyfork_session 的值，然后：
gf login --cookie '_greasyfork_session=…'
gf login --cookie -                  # 从 stdin 读，不进 shell history
```

`--cookie` 接受裸值、`name=value` 对，或整条 `Cookie:` 头；也能自动分辨这个值是**已转义**的（浏览器收到的 `Set-Cookie` 原样）还是**已解码**的（DevTools 显示的样子）。保存前会先向站点校验，所以失效的 cookie 会立刻报错，而不是拖到下次发布才炸。

**只落盘 cookie**，权限 0600，位置在**所有平台**统一为 `~/.config/gf/session.json` —— Windows / macOS / Linux 都一样（设了 `XDG_CONFIG_HOME` 则用 `$XDG_CONFIG_HOME/gf/session.json`；`GF_SESSION` 与 `GF_CONFIG_DIR` 可覆盖）。

**刻意不用** Windows 的 `%APPDATA%`：那是 *roaming* 配置目录，域账号在登录/注销时会被 Windows 同步到服务器，会话 cookie 会跟着跑。0.2.3 之前的版本用的就是它，**首次读取会自动把旧会话迁移**到新位置并删掉旧文件，所以升级不会把你登出。一旦你设了 `GF_CONFIG_DIR`，就**不会**发生任何迁移 —— 显式指定的目录不碰。

`gf logout` **只删本地文件、不碰任何别的东西** —— 不会影响你的浏览器登录态。站点的登出会调 `invalidate_all_sessions!`，即把该账号所有会话踢下线；`gf logout --server` 才会这么做，并且会明确告诉你。

全局参数，放子命令**前后都行**：

```
--proxy URL     代理，例如 http://127.0.0.1:7890（默认自动探测）
--no-proxy      完全不走代理
--timeout SECS  单次请求超时（默认 30）
--locale CODE   站点语言，例如 en 或 zh-CN（默认 en）
-v, --verbose   打印每个请求
--json          机器可读输出（search / info / versions / user / sites / whoami / publish）
```

### 作为库使用

```ts
import { Client } from '@greasyfork/cli';

const client = new Client({ locale: 'zh-CN' });

const { query } = await client.search({ query: 'bilibili', perPage: 10 });
for (const s of query) console.log(s.id, s.name, s.daily_installs);

const script = await client.script(405130);
const source = await client.raw(script.code_url!);   // 脚本原文
const meta = parseUserscriptMeta(source);
console.log(meta.get('version'), meta.get('match'));
```

## 为什么二进制有 60–95 MB？

因为它其实不是"你的程序"，而是**一整个 JavaScript 运行时 + 你的程序**。本机实测：

| | 大小 |
|---|---|
| 我们的全部代码（打包 + minify 后） | **65 KB** |
| hello-world 编译成 Windows 产物 | 98.5 MB |
| 我们的 CLI 编译成 Windows 产物 | 98.5 MB |
| 我们的 CLI 再 gzip | 38.2 MB（小 2.6 倍） |

hello-world 和真实 CLI 只差 **15 KB** —— 所以体积来自运行时，不是代码。`--minify` 只省 18 KB，`--bytecode` 反而**更大**。

UPX 看着像答案 —— 能把 98 MB 压到 33 MB（`--lzma` 27 MB）—— 但**压完跑不起来**。Bun 把 JS 载荷附加在可执行文件尾部，UPX 之后运行时读不到它：压过的二进制打出的是 Bun 自己的版本号而不是 `gf` 的，还把 `search` 当成脚本路径（`error: Script not found "search"`）。`--overlay=copy` 也救不回来。所以这里**不用 UPX**。

于是只剩"压缩分发"这一条诚实的路，这就是 Release 提供 `.tar.gz` / `.zip` 的原因。**如果在意体积，请从 npm 装** —— 约 50 KB，因为运行时本来就在你机器上；二进制是给没装 Node 的机器准备的。

## 注意

- **接口无承诺：** 下面这些端点是非文档化的，随时可能变。它们集中在 `src/client.ts`。
- **限速：** `robots.txt` 要求 `Crawl-delay: 1`。批量调用请自行加延迟；能用 `scripts.json`（每页 100）就不要逐条查。
- **`gf` 是个热门名字。** GoFrame 的 CLI 也叫 `gf`，两者同时装会有一个在 `PATH` 里遮蔽另一个。
- **发布没有 API。** `gf publish` 走的是站点自身的 HTML 表单 —— 这是唯一可行的路，也正是为什么表单字段名和 CSRF token 每次都从**实时页面**读取，而不是照某份规格硬编码。另有 `POST /<locale>/script_versions/prefill` 端点、只需 session cookie，但它渲染出来的是**同一张表单、供人工提交**，并不是发布通路，`gf` 没有用它。

## 排错

| 现象 | 原因与处理 |
|---|---|
| `cannot reach https://api.greasyfork.org/...` | 没探测到代理。加 `--proxy http://127.0.0.1:7890`，或设 `git config --global https.proxy`。 |
| `did not return JSON` 且响应体为空 | 命中了主站端点却没跟随它的 308。只在改传输层时相关 —— `src/http.ts` 会跟随重定向。 |
| `gf __VERSION__` | 二进制是直接从 `src/` 编的，没先跑 `npm run build`，版本占位符没被替换。 |
| `error: Script not found "search"` | 你在跑一个被 UPX 压过的二进制。Bun 的载荷撑不过 UPX。 |

## 开发

```bash
npm install
npm run typecheck     # tsc 检查 src + tests
npm test              # vitest（离线，不联网）
npm run build         # tsc → dist/，并注入 package.json 里的版本号
npm pack --dry-run    # 查看将要发布的内容
```

`scripts/inject-version.mjs` 会把 `package.json` 的版本号写进编译产物里的 `__VERSION__` 占位符，这样发布后的代码不必在运行时解析 `package.json`（它在 `dist/` 下的相对路径会变）。注入后它还会校验，发现残留占位符就让构建失败。

### 本地编译二进制

```bash
npm run build
bun build ./dist/cli.js --compile --minify --target=bun-windows-x64 --outfile gf.exe
```

`--target` 可选：`bun-linux-x64`、`bun-linux-arm64`、`bun-darwin-x64`、`bun-darwin-arm64`、`bun-windows-x64`。
在 Git Bash 里给原生程序传输出路径要用 `C:/...` 这种**原生正斜杠路径** —— `/c/...` 会被当成相对路径。

## 发版

```bash
npm version patch        # 或 minor / major，会同步 package.json
git push --follow-tags
```

| workflow 文件 | 作用 |
|---|---|
| `.github/workflows/release.yml` | 编译 5 个平台、给 macOS 产物做 ad-hoc 签名、**打成 tar.gz/zip**、生成 `SHA256SUMS.txt`、发布 GitHub Release |
| `.github/workflows/publish-npm.yml` | 把 `@greasyfork/cli` 发到 npm，并带 provenance |

两者都可以在 Actions 页面手动触发；都需要填版本号，与 `package.json` 不一致会直接失败 —— 所以 tarball / 二进制 / npm 版本三者不可能对不上。

### 开启 npm 自动发布

**方案 A —— npm token。** 到 npmjs.com 建 **Granular Access Token**：权限 read + write、范围限定 `@greasyfork`、**必须开启 Bypass 2FA**（账号 2FA 是 `auth-and-writes`，而 CI runner 输不了一次性验证码）。存为仓库 secret `NPM_TOKEN`。

**方案 B —— Trusted Publisher（不用 secret）。** 包在 npm 上存在过一次之后，到包设置里加 Trusted Publisher：仓库 `Weidows/greasyfork-cli`、workflow **`publish-npm.yml`**、**Environment 留空** —— 然后把 workflow 里那行 `NODE_AUTH_TOKEN` 删掉即可。

> workflow 文件名本身是配置的一部分：改名 `publish-npm.yml` 会让它静默失效。

workflow 发布前会先升级 npm（Node 22 自带 npm 10.x，而 trusted publishing 需要 npm ≥ 11.5.1）；若该版本已在 npm 上会**打 notice 直接跳过**，重推 tag 不会把 run 弄红。

## 用到的接口

| 用途 | 端点 |
|---|---|
| 搜索 / 排序 | `GET api.greasyfork.org/scripts.json?q=&page=&per_page=&sort=&locale=` |
| 按站点 | `GET api.greasyfork.org/scripts/by-site/<site>.json` |
| 站点清单 | `GET api.greasyfork.org/scripts/by-site.json` → `{site: count}`（是 map 不是 list） |
| 脚本详情 | `GET api.greasyfork.org/scripts/<id>-<slug>.json` |
| 解析 slug | `GET greasyfork.org/<locale>/scripts/<id>.json`（308 → 上面那条） |
| 历史版本 | `GET greasyfork.org/<locale>/scripts/<id>/versions.json`（308） |
| 用户脚本 | `GET greasyfork.org/<locale>/users/<id\|slug>.json`（308） |
| 原始代码 | `https://update.greasyfork.org/scripts/<id>/<name>.user.js` |
| 更新元数据 | 同上去掉 `.user.js` 换成 `.meta.js` |

**最大的坑：** `greasyfork.org/<locale>/scripts.json` 会**忽略** `q` / `page` / `sort`，永远返回默认榜单。搜索必须走 `api.` 子域。

带版本号的代码 URL 会带查询串（`.../style.user.js?version=1284070`），所以文件名与 `.meta.js` 推导都要先剥掉查询串。
