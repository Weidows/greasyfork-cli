# greasyfork-cli

Search, inspect and download [Greasy Fork](https://greasyfork.org) userscripts from the
terminal. Zero runtime dependencies.

Ships two things from one source tree:

- **`greasyfork-cli`** — the importable library (typed, ESM)
- **`gfc`** / **`greasyfork-cli`** — the CLI

> **Scope.** Greasy Fork has a real read-only JSON API, it just is not documented: the
> help page only says to look for `<link rel="alternate" type="application/json">` on any
> page. Every endpoint below was verified against the live site.
> **Not supported:** publishing, rating, commenting or favouriting — those need a logged-in
> session plus CSRF, and are deliberately out of scope.

## Install

```bash
npm i -g greasyfork-cli     # or: npx greasyfork-cli search bilibili
```

Requires Node 18+ (uses the built-in `node:test`-era standard library only). **No runtime
dependencies** — `npm ls greasyfork-cli` shows nothing beyond this package.

## Usage

```bash
gfc search bilibili                # search
gfc search --sort created -n 10    # newest; also updated / installs / rating / name
gfc search --site bilibili.com     # only scripts for one site
gfc --locale zh-CN search 视频     # Chinese site
gfc info 405130                    # details
gfc download 405130 -o ./scripts --with-meta
gfc cat 405130 | less              # print source
gfc versions 405130                # release history
gfc user 584991-windrunnermax      # everything by one author
gfc sites -n 20                    # scripts per site
gfc open 405130 --launch           # open the script page
gfc check ./scripts                # check local scripts for updates
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
import { Client } from 'greasyfork-cli';

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

## The proxy problem (read this before editing the transport)

`node:https` and the global `fetch` (undici) **both ignore `HTTP_PROXY` / `HTTPS_PROXY`**.
Greasy Fork is unreachable from mainland China without a proxy, so this cannot be left to the
environment. Measured on this machine: with `HTTPS_PROXY` exported, `fetch` to
`api.greasyfork.org` fails after ~10.5 s; the hand-rolled tunnel below returns 200 in ~2 s.

`src/proxy.ts` therefore implements HTTPS-over-proxy itself: `CONNECT` + `tls.connect`,
roughly 80 lines, no dependency. The proxy is discovered in this order:

1. `GREASYFORK_CLI_PROXY`, `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`
2. `git config --global https.proxy` (many machines only configure git)

Only `http://` and `https://` proxies are supported; a `socks5://` URL is rejected loudly
rather than silently failing.

## Redirects are load-bearing

`greasyfork.org/<locale>/scripts/<id>.json` (and `versions.json`, `users/<who>.json`) answer
**308** to `api.greasyfork.org/...`. `node:http` does not follow redirects, so `src/http.ts`
does it manually. Without that, every main-site endpoint returns an empty 308 body that looks
like an empty JSON reply — which is exactly how `info`, `download`, `cat`, `versions` and
`user` all failed the first time.

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
npm run typecheck     # tsc --noEmit over src + tests
npm test              # vitest (offline, no network)
npm run build         # tsc -> dist/ + inject the version from package.json
npm pack --dry-run    # inspect what would be published
```

`scripts/inject-version.mjs` stamps `package.json`'s version into the compiled
`__VERSION__` placeholder, so the published code never has to resolve `package.json` at
runtime (its relative path changes under `dist/`).

### Install-verification before publishing

```bash
npm pack
npm i -g ./greasyfork-cli-0.1.0.tgz
gfc --version && gfc search bilibili -n 3
npm uninstall -g greasyfork-cli
```

## Notes

- **No API promise:** these endpoints are undocumented and can change. They are centralised in
  `src/client.ts`.
- **Rate limit:** `robots.txt` asks for `Crawl-delay: 1`. Add delays in loops; prefer the bulk
  `scripts.json` (100 per page) over per-script calls.
- **Publishing** has no API. There is only a prefill URL that populates the form for a human to
  submit: `POST greasyfork.org/<locale>/script_versions/prefill`, which needs a session cookie.

## Licence

MIT
