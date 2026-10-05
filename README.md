# greasyfork-cli

命令行浏览、搜索、下载 [Greasy Fork](https://greasyfork.org) 用户脚本。

两层结构：

- **`package greasyfork`**（仓库根）= 可 `import` 的客户端库，零第三方依赖
- **`cmd/gf`** = 薄壳 CLI，编译成一个静态二进制

> **边界**：Greasy Fork 有**官方只读 JSON API**，只是没写进文档（help/api 只说"去页面上找 `<link rel="alternate" type="application/json">`"）。本项目的端点是实测 + 开源仓库 `config/routes.rb` 交叉验证得出的。
> **不做**：发脚本 / 评分 / 评论 / 收藏 —— 那些需要登录 session + CSRF，属于另一个量级的工作，故意不实现。

## 安装

```bash
# 需要 Go 1.24+
go install github.com/Weidows/greasyfork-cli/cmd/gf@latest

# 或从源码
git clone https://github.com/Weidows/greasyfork-cli
cd greasyfork-cli && go build -o gf ./cmd/gf
```

**零依赖**：`go.mod` 里没有任何 require，`go install` 不需要拉第三方包（连 CLI 参数解析都是自己写的，见下方"设计取舍"）。

## 用法

```bash
gf search bilibili                 # 搜索
gf search --sort created -n 10     # 最新发布；updated/installs/rating/name
gf search --site bilibili.com      # 只搜某个站点的脚本
gf --locale zh-CN search 视频      # 中文站点
gf info 405130                     # 详情
gf download 405130 -o ./scripts --with-meta
gf cat 405130 | less               # 看源码
gf versions 405130                 # 历史版本
gf user 584991-windrunnermax       # 某作者的全部脚本
gf sites -n 20                     # 站点脚本数量排行
gf open 405130 --launch            # 打开脚本页
gf check ./scripts                 # 检查本地脚本是否过时
```

`<script>` 接受 `405130`、`405130-slug`、或完整 URL。

### 全局参数（放子命令前后都行）

```
--proxy URL     代理，如 http://127.0.0.1:7890（默认自动探测）
--no-proxy      完全不走代理
--timeout SECS  单请求超时（默认 30）
--locale CODE   站点语言，en / zh-CN …（默认 en）
-v, --verbose   打印每个请求
--json          机器可读输出（search / info / versions / user / sites）
```

### 作为库使用

```go
import greasyfork "github.com/Weidows/greasyfork-cli"

c := greasyfork.NewClient(greasyfork.WithLocale("zh-CN"))

res, err := c.Search(ctx, greasyfork.SearchOptions{Query: "bilibili", PerPage: 10})
if err != nil { return err }
for _, s := range res.Query {
    fmt.Println(s.ID, s.Name, s.Author(), s.DailyInstalls)
}

s, _ := c.Script(ctx, 405130)
body, _ := c.Raw(ctx, s.CodeURL)               // 原始脚本源码
meta := greasyfork.ParseUserscriptMeta(string(body))
updates := greasyfork.IsNewer(meta.First("version"), "6.0.0")
```

`NewClient` 自动复用机器上已有的代理（环境变量 → `git config --global https.proxy`），
所以国内环境不用额外配置。

## 设计取舍

| 决定 | 为什么 |
|---|---|
| **零第三方依赖** | 用户偏好"不要杂七杂八的依赖"；`go install` 拉包在国内也可能失败 |
| **自己写参数解析而非 stdlib `flag`** | `flag` 遇到第一个位置参数就停止解析，`gf download 405130 -o dir` 里的 `-o` 会被静默丢弃 |
| **自己算 CJK/emoji 显示宽度而非 `go-runewidth`** | 脚本名一堆 🔥 和中文，`tabwriter` 会错位；为省一个依赖值得自己写 60 行 |
| **`rune` 级宽度表** | 保证 `ID / Name / Fan` 各列在混合中英 emoji 时仍对齐（有单测守着） |

## 实测的接口

| 用途 | 端点 |
|---|---|
| 搜索 / 排序 | `GET api.greasyfork.org/scripts.json?q=&page=&per_page=&sort=&locale=` |
| 按站点 | `GET api.greasyfork.org/scripts/by-site/<site>.json` |
| 站点清单 | `GET api.greasyfork.org/scripts/by-site.json` → `{site: count}`（是 map 不是 list） |
| 脚本详情 | `GET api.greasyfork.org/scripts/<id>-<slug>.json` |
| 解析 slug | `GET greasyfork.org/<locale>/scripts/<id>.json` |
| 历史版本 | `GET greasyfork.org/<locale>/scripts/<id>/versions.json` |
| 用户脚本 | `GET greasyfork.org/<locale>/users/<id\|slug>.json` |
| 原始代码 | `https://update.greasyfork.org/scripts/<id>/<name>.user.js` |
| 更新元数据 | 同上去掉 `.user.js` 换 `.meta.js` |

**最大的坑**：`greasyfork.org/<locale>/scripts.json` 会**忽略** `q/page/sort`，永远返回默认榜单；
搜索必须走 `api.greasyfork.org` 子域。`?sort=` 支持 `created/updated/installs/rating/name`。

## 注意

- **无 API 承诺**：端点是非文档化的，随时可能变。全部集中在 `client.go` 顶部。
- **限速**：`robots.txt` 是 `Crawl-delay: 1`，批量调用请自行加延迟。
- **网络**：国内直连 `greasyfork.org` / `api.greasyfork.org` 不通，需代理（工具会自动读 git 配置）。

## 开发

```bash
go build ./...            # 构建
go vet ./...              # 静态检查
go test ./... -count=1    # 单元测试（纯离线，不联网）
gofmt -l .                # 格式检查

# 交叉编译
CGO_ENABLED=0 GOOS=linux  GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o dist/gf-linux-amd64   ./cmd/gf
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o dist/gf-darwin-arm64  ./cmd/gf

# 注入版本号
go build -ldflags "-s -w -X github.com/Weidows/greasyfork-cli.Version=1.0.0" -o gf ./cmd/gf
```
