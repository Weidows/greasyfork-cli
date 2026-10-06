# @greasyfork/cli

[English](README.md) | **简体中文**

在终端里搜索、查看、下载 [Greasy Fork](https://greasyfork.org) 用户脚本。**零运行时依赖**。

> **非官方项目。** 这是社区客户端，与 Greasy Fork 官方及其维护者无关，也未获其背书。它只读取站点公开的 JSON 接口。
>
> 同一份源码产出两样东西：
>
> - **`@greasyfork/cli`** —— 可 `import` 的库（带类型，ESM）
> - **`gf`** —— 命令行工具

> **能力边界。** Greasy Fork 确实有只读 JSON API，只是没写进文档：help 页只说"去页面上找 `<link rel="alternate" type="application/json">`"。下面所有端点都对着线上实测过。
> **不支持：** 发布 / 评分 / 评论 / 收藏 —— 那些需要登录 session + CSRF，刻意不做。

## 安装

### npm

```bash
npm i -g @greasyfork/cli     # 或直接：npx @greasyfork/cli search bilibili
```

需要 Node 18+。**无运行时依赖**（`npm ls @greasyfork/cli` 只有它自己）。

### 预编译二进制（无需 Node）

从 [Releases](https://github.com/Weidows/greasyfork-cli/releases) 下载对应平台的文件：

| 平台 | 文件 |
|---|---|
| Linux x64 | `gf-linux-x64` |
| Linux arm64 | `gf-linux-arm64` |
| macOS Intel | `gf-darwin-x64` |
| macOS Apple Silicon | `gf-darwin-arm64` |
| Windows x64 | `gf-windows-x64.exe` |

```bash
chmod +x gf-linux-x64 && ./gf-linux-x64 search bilibili
```

macOS 上若是**用浏览器下载**的（会被打上隔离标记），先解除限制：

```bash
xattr -d com.apple.quarantine gf-darwin-arm64
```

二进制已做 ad-hoc 签名，但浏览器下载的隔离属性仍需手动移除。

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
```

`<script>` 参数接受 `405130`、`405130-slug` 或完整 URL 三种写法。

### 全局参数（放子命令前后都行）

```
--proxy URL     代理，例如 http://127.0.0.1:7890（默认自动探测）
--no-proxy      完全不走代理
--timeout SECS  单次请求超时（默认 30）
--locale CODE   站点语言，例如 en 或 zh-CN（默认 en）
-v, --verbose   打印每个请求
--json          机器可读输出（search / info / versions / user / sites）
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

`new Client()` 会自动复用机器上已有的代理，国内环境无需额外配置。

## 代理问题（改传输层之前务必先读）

`node:https` 和全局 `fetch`(undici) **都不认 `HTTP_PROXY` / `HTTPS_PROXY`**。而国内直连 Greasy Fork 是不通的，所以不能交给环境变量。本机实测：导出 `HTTPS_PROXY` 后，`fetch` 访问 `api.greasyfork.org` 约 10.5 秒失败；手写隧道约 2 秒返回 200。

**更关键的一点：靠 `https.Agent` 也救不了，因为二进制是 Bun 编的。** Bun **完全忽略 `https.Agent#createConnection`**。同一份代码、同一台机器实测：Node 每次请求调用 1 次，Bun 调用 **0 次**，然后请求直接打到代理地址上（`ECONNREFUSED`）。也就是说，基于 Agent 的代理方案在 Bun 二进制里根本不可能工作 —— 这不是"可能不稳"，是实测证实的必然失败。

所以传输层**不再使用 `node:http(s).request`**：`src/proxy.ts` 只导出 `openSocket`（直连，或手写 `CONNECT` 隧道），`src/http.ts` 在这个 socket 上手写 HTTP/1.1，解析逻辑放在 `src/http1.ts`（纯函数，可离线单测）。全程只涉及 `node:net` + `node:tls`，两者在 Node 与 Bun 上行为一致 —— 已用**编译出的 Windows 二进制**跑真实代理验证通过。

顺带一提，`http.request({ method: 'CONNECT' })` 在 Bun 里直接抛 `ERR_INVALID_URL`，所以那条路也是死的。

代理按以下顺序探测：

1. `GREASYFORK_CLI_PROXY`、`GF_PROXY`、`https_proxy`、`HTTPS_PROXY`、`http_proxy`、`HTTP_PROXY`
2. `git config --global https.proxy`（很多机器只给 git 配了代理）

只支持 `http://` / `https://` 代理；`socks5://` 会明确报错而不是静默失败。建连阶段会**重试一次** —— 通过代理新建 CONNECT+TLS 偶尔会在首次使用时卡住，而重试一次 GET 是无害的。

## 重定向是承重结构

`greasyfork.org/<locale>/scripts/<id>.json`（以及 `versions.json`、`users/<who>.json`）会返回 **308** 跳到 `api.greasyfork.org`。而 `node:http` 不跟随重定向，所以 `src/http.ts` 手动跟随。没有这一步，所有主站端点都会返回一个空的 308 响应体，看起来像"返回了空 JSON" —— 这正是当初 `info` / `download` / `cat` / `versions` / `user` 全部失败、而 `search` / `sites` 正常的原因。

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

## 开发

```bash
npm install
npm run typecheck     # tsc 检查 src + tests
npm test              # vitest（离线，不联网）
npm run build         # tsc → dist/，并注入 package.json 里的版本号
npm pack --dry-run    # 查看将要发布的内容
```

`scripts/inject-version.mjs` 会把 `package.json` 的版本号写进编译产物里的 `__VERSION__` 占位符，这样发布后的代码不必在运行时解析 `package.json`（它在 `dist/` 下的相对路径会变）。

### 本地编译二进制

```bash
npm run build
bun build ./dist/cli.js --compile --minify --target=bun-windows-x64 --outfile gf.exe
```

`--target` 可选：`bun-linux-x64`、`bun-linux-arm64`、`bun-darwin-x64`、`bun-darwin-arm64`、`bun-windows-x64`。
给原生程序传输出路径时要用 `C:/...` 这种**原生正斜杠路径**（在 Git Bash 里传 `/c/...` 会被当成相对路径）。
**必须**先跑 `npm run build` 再编译：直接编 `src/` 会让 `--version` 显示占位符 `__VERSION__`。`npm run build` 会在注入后**校验** `dist/` 里没有残留占位符，有则直接失败。

## 发版

有**两个** workflow 都监听 `v*` tag，这是有意为之 —— 一个产二进制，一个发 npm，两者互不拖累。

```bash
npm version patch        # 或 minor / major，会同步 package.json
git push --follow-tags
```

| workflow 文件 | 作用 |
|---|---|
| `.github/workflows/release.yml` | 编译 5 个平台、给 macOS 产物做 ad-hoc 签名、生成 `SHA256SUMS.txt`、发布 GitHub Release |
| `.github/workflows/publish-npm.yml` | 把 `@greasyfork/cli` 发到 npm，并带 provenance |

两者也都可以在 Actions 页面手动触发，都需要填版本号（与 `package.json` 不一致会直接失败），所以 tarball / 二进制 / npm 版本三者不可能对不上。

### 开启 npm 自动发布

`publish-npm.yml` 需要下面二选一：

**方案 A —— npm token（立刻可用）**。到 npmjs.com 建 **Granular Access Token**：

- 权限：read + write，范围限定 `@greasyfork` org
- **Bypass 2FA：必须开启** —— 因为账号 2FA 是 `auth-and-writes`，而 CI runner 没法输入一次性验证码

然后存到仓库 secret `NPM_TOKEN`（Settings → Secrets and variables → Actions → New repository secret）。

**方案 B —— Trusted Publisher（完全不用 secret）**。包在 npm 上存在过一次之后，到包设置里加 Trusted Publisher：仓库填 `Weidows/greasyfork-cli`，workflow 填 **`publish-npm.yml`**，**Environment 留空**。然后把 workflow 里那行 `NODE_AUTH_TOKEN` 删掉即可，顺带免费获得 provenance。

> **workflow 文件名本身是配置的一部分。** Trusted Publisher 绑定的是"仓库 + workflow 文件名"，改名 `publish-npm.yml` 会静默失效。

workflow 在发布前会先升级 npm：Node 22 自带 npm 10.x，而 trusted publishing 需要 npm ≥ 11.5.1。另外它检测到该版本已在 npm 上会**直接跳过**，所以重推 tag 不会把 run 弄红。

## 注意

- **接口无承诺：** 这些端点是非文档化的，随时可能变。它们集中在 `src/client.ts`。
- **限速：** `robots.txt` 要求 `Crawl-delay: 1`。批量调用请自行加延迟；能用 `scripts.json`（每页 100）就不要逐条查。
- **发布脚本**没有 API。只有 prefill URL 能填充表单供人工提交：`POST greasyfork.org/<locale>/script_versions/prefill`，需要 session cookie。
- 二进制里的 `gf` 可能与你机器上其他同名工具冲突（例如 GoFrame 的 CLI 也叫 `gf`），按需调整 PATH。

## 许可

MIT
