# @greasyfork/cli

**English** | [简体中文](README.zh-CN.md)

Search, inspect and download [Greasy Fork](https://greasyfork.org) userscripts from the
terminal. Zero runtime dependencies.

> **Unofficial.** This is a community client, not affiliated with or endorsed by Greasy Fork
> or its maintainers. It only reads the site's public JSON endpoints.

One source tree ships two things:

- **`@greasyfork/cli`** — the importable library (typed, ESM)
- **`gf`** — the command line tool

> **Scope.** Greasy Fork has a real read-only JSON API, it just is not documented: the help
> page only says to look for `<link rel="alternate" type="application/json">` on any page.
> Every endpoint below was verified against the live site.
> **Not supported:** publishing, rating, commenting or favouriting — those need a logged-in
> session plus CSRF, and are deliberately out of scope.

## Install

### npm

```bash
npm i -g @greasyfork/cli     # or: npx @greasyfork/cli search bilibili
```

Requires Node 18+. **No runtime dependencies** — `npm ls @greasyfork/cli` shows only itself.

### Prebuilt binary (no Node required)

Download the file for your platform from
[Releases](https://github.com/Weidows/greasyfork-cli/releases):

| Platform | Asset |
|---|---|
| Linux x64 | `gf-linux-x64` |
| Linux arm64 | `gf-linux-arm64` |
| macOS Intel | `gf-darwin-x64` |
| macOS Apple Silicon | `gf-darwin-arm64` |
| Windows x64 | `gf-windows-x64.exe` |

```bash
chmod +x gf-linux-x64 && ./gf-linux-x64 search bilibili
```

On macOS, a binary **downloaded through a browser** carries the quarantine flag and will be
blocked; clear it first:

```bash
xattr -d com.apple.quarantine gf-darwin-arm64
```

The binaries are ad-hoc signed, but the quarantine attribute still has to go.

## Usage

```bash
gf search bilibili                # search
gf search --sort created -n 10    # newest; also updated / installs / rating / name
gf search --site bilibili.com     # only scripts for one site
gf --locale zh-CN search 视频     # Chinese site
gf info 405130                    # details
gf download 405130 -o ./scripts --with-meta
gf cat 405130 | less              # print source
gf versions 405130                # release history
gf user 584991-windrunnermax      # everything by one author
gf sites -n 20                    # scripts per site
gf open 405130 --launch           # open the script page
gf check ./scripts                # check local scripts for updates
```

`<script>` accepts `405130`, `405130-slug`, or a full URL.

### Global flags (before or after the subcommand)

```
--proxy URL     proxy, e.g. http://127.0.0.1:7890 (auto-detected)
--no-proxy      never use a proxy
--timeout SECS  per-request timeout (default 30)
--locale CODE   site locale, e.g. en or zh-CN (default en)
-v, --verbose   log every request
--json          machine-readable output (search / info / versions / user / sites)
```

### As a library

```ts
import { Client } from '@greasyfork/cli';

const client = new Client({ locale: 'zh-CN' });

const { query } = await client.search({ query: 'bilibili', perPage: 10 });
for (const s of query) console.log(s.id, s.name, s.daily_installs);

const script = await client.script(405130);
const source = await client.raw(script.code_url!);      // raw userscript text
const meta = parseUserscriptMeta(source);
console.log(meta.get('version'), meta.get('match'));
```

`new Client()` reuses whatever proxy the machine already has, so a CN environment needs no
extra configuration.

## The proxy problem (read before touching the transport)

`node:https` and the global `fetch` (undici) **both ignore `HTTP_PROXY` / `HTTPS_PROXY`**.
Greasy Fork is unreachable from mainland China without a proxy, so this cannot be left to the
environment. Measured here: with `HTTPS_PROXY` exported, `fetch` to `api.greasyfork.org` fails
after ~10.5 s; the hand-rolled path returns 200 in ~2 s.

**And an agent will not save you, because the binaries are compiled by Bun:** Bun *ignores*
`https.Agent#createConnection`. Same code, same machine — Node invokes it once per request,
Bun invokes it **zero** times and the request then goes straight at the proxy address
(`ECONNREFUSED`). An agent-based proxy is dead on arrival in a Bun binary.

So the transport does not use `node:http(s).request` at all. `src/proxy.ts` exports
`openSocket` (direct, or a hand-written `CONNECT` tunnel) and `src/http.ts` speaks HTTP/1.1
over that socket by hand, with parsing in `src/http1.ts`. Only `node:net` + `node:tls` are
involved, and both behave identically on Node and Bun — verified by running the compiled
Windows binary against a real proxy.

Proxy discovery order:

1. `GREASYFORK_CLI_PROXY`, `GF_PROXY`, `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`
2. `git config --global https.proxy` (many machines only configure git)

Only `http://` and `https://` proxies are supported; a `socks5://` URL is rejected loudly
rather than failing silently. Connection setup is retried once, because a fresh CONNECT+TLS
through a proxy occasionally stalls on first use.

## Redirects are load-bearing

`greasyfork.org/<locale>/scripts/<id>.json` (and `versions.json`, `users/<who>.json`) answer
**308** to `api.greasyfork.org/...`. `node:http` does not follow redirects, so `src/http.ts`
does it manually. Without that, every main-site endpoint returns an empty 308 body that reads
as an empty JSON reply — which is exactly how `info`, `download`, `cat`, `versions` and `user`
all failed the first time, while `search` and `sites` worked.

## Endpoints used

| Purpose | Endpoint |
|---|---|
| search / sort | `GET api.greasyfork.org/scripts.json?q=&page=&per_page=&sort=&locale=` |
| by site | `GET api.greasyfork.org/scripts/by-site/<site>.json` |
| site chart | `GET api.greasyfork.org/scripts/by-site.json` → `{site: count}` (a map, not a list) |
| script detail | `GET api.greasyfork.org/scripts/<id>-<slug>.json` |
| resolve slug | `GET greasyfork.org/<locale>/scripts/<id>.json` (308 → above) |
| version history | `GET greasyfork.org/<locale>/scripts/<id>/versions.json` (308) |
| user's scripts | `GET greasyfork.org/<locale>/users/<id\|slug>.json` (308) |
| raw code | `https://update.greasyfork.org/scripts/<id>/<name>.user.js` |
| update meta | same URL with `.user.js` → `.meta.js` |

**Biggest gotcha:** `greasyfork.org/<locale>/scripts.json` **ignores** `q` / `page` / `sort`
and always returns the default chart. Search must go through the `api.` subdomain.

Versioned code URLs carry a query string (`.../style.user.js?version=1284070`), so filenames
and `.meta.js` derivation strip the query first.

## Development

```bash
npm install
npm run typecheck     # tsc over src + tests
npm test              # vitest (offline, no network)
npm run build         # tsc -> dist/ + inject the version from package.json
npm pack --dry-run    # inspect what would be published
```

`scripts/inject-version.mjs` stamps `package.json`'s version into the compiled `__VERSION__`
placeholder, so the published code never has to resolve `package.json` at runtime (its
relative path changes under `dist/`). **Always run `npm run build` before compiling a
binary** — compiling straight from `src/` ships a binary whose `--version` prints
`__VERSION__`.

### Building a binary locally

```bash
npm run build
bun build ./dist/cli.js --compile --minify --target=bun-windows-x64 --outfile gf.exe
```

Available targets: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`,
`bun-windows-x64`. When passing an output path to a native program from Git Bash, use a
native forward-slash path (`C:/...`) — `/c/...` is taken as a relative path.

### Install verification before publishing

```bash
npm pack
npm i -g ./greasyfork-cli-0.1.0.tgz
gf --version && gf search bilibili -n 3
npm uninstall -g @greasyfork/cli
```

## Releasing

Two workflows listen on `v*` tags, on purpose — one ships binaries, one ships npm. They fail
independently.

```bash
npm version patch        # or minor / major, bumps package.json
git push --follow-tags
```

| Workflow file | What it does |
|---|---|
| `.github/workflows/release.yml` | Compiles all five platforms, ad-hoc signs the macOS ones, writes `SHA256SUMS.txt`, publishes a GitHub Release |
| `.github/workflows/publish-npm.yml` | Publishes `@greasyfork/cli` to npm with provenance |

Both can also be started by hand from the Actions tab; each asks for the version and fails if
it does not match `package.json`, so a tarball, a binary and an npm version can never disagree.

### Enabling the npm publish

`publish-npm.yml` needs one of these before it can publish:

**Option A — npm token (works immediately).** On npmjs.com create a **Granular Access Token**:

- Permissions: read + write, scoped to the `@greasyfork` org
- **Bypass 2FA: enabled** — this is required, because the account uses `auth-and-writes` 2FA
  and a CI runner cannot type a one-time password

Then store it as the repository secret `NPM_TOKEN`
(Settings → Secrets and variables → Actions → New repository secret).

**Option B — Trusted Publisher (no secret at all).** After the package exists on npm once,
add a Trusted Publisher in the package settings: repository `Weidows/greasyfork-cli`, workflow
**`publish-npm.yml`**, environment **left empty**. Then delete the `NODE_AUTH_TOKEN` line from
the workflow. This also gives you provenance for free.

> **The workflow file name is part of the configuration.** A Trusted Publisher binds to the
> repository *and* the workflow file name, so renaming `publish-npm.yml` silently breaks it.

The workflow upgrades npm before publishing: Node 22 ships npm 10.x, and trusted publishing
requires npm ≥ 11.5.1. It also skips cleanly when the version is already on npm, so re-pushing
a tag does not turn the run red.

## Notes

- **No API promise:** these endpoints are undocumented and can change. They are centralised in
  `src/client.ts`.
- **Rate limit:** `robots.txt` asks for `Crawl-delay: 1`. Add delays in loops; prefer the bulk
  `scripts.json` (100 per page) over per-script calls.
- **Publishing** has no API. There is only a prefill URL that populates the form for a human to
  submit: `POST greasyfork.org/<locale>/script_versions/prefill`, which needs a session cookie.
- **`gf` is a popular name.** GoFrame's CLI is also `gf`; if both are installed, one will shadow
  the other on `PATH`. Adjust as needed.

## Licence

MIT
