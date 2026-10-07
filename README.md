# gf — Greasy Fork CLI

**English** | [简体中文](README.zh-CN.md)

<img src="https://raw.githubusercontent.com/Weidows/greasyfork-cli/main/assets/header.webp" alt="gf — Greasy Fork's fork badge beside a script list, in the site's maroon and green palette" width="100%">

**Search, inspect and download [Greasy Fork](https://greasyfork.org) userscripts from the
terminal.**<br>
Published as [`@greasyfork/cli`](https://www.npmjs.com/package/@greasyfork/cli) · zero runtime
dependencies · ships a typed library *and* the `gf` command.

[![npm](https://img.shields.io/npm/v/%40greasyfork%2Fcli?style=flat-square&label=npm)](https://www.npmjs.com/package/@greasyfork/cli)
[![release](https://img.shields.io/github/v/release/Weidows/greasyfork-cli?sort=semver&style=flat-square)](https://github.com/Weidows/greasyfork-cli/releases/latest)
[![license](https://img.shields.io/github/license/Weidows/greasyfork-cli?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen?style=flat-square)](package.json)
[![release workflow](https://github.com/Weidows/greasyfork-cli/actions/workflows/release.yml/badge.svg)](https://github.com/Weidows/greasyfork-cli/actions/workflows/release.yml)
[![publish workflow](https://github.com/Weidows/greasyfork-cli/actions/workflows/publish-npm.yml/badge.svg)](https://github.com/Weidows/greasyfork-cli/actions/workflows/publish-npm.yml)

> **Unofficial.** A community client, not affiliated with or endorsed by Greasy Fork or its
> maintainers. It reads the site's public JSON API, and — for `login` / `publish` — drives the
> site's own HTML forms. Those are not part of any documented API, so they can change without
> notice; treat `publish` as a convenience, not a stable contract.
>
> **Not supported:** rating, commenting or favouriting — deliberately out of scope.
>
> `publish` is a real, public write to your account. It is never automatic: `--dry-run` prints
> what would be sent, and an unlisted script plus a throwaway account is the sane way to try it.

## Install

```bash
npm i -g @greasyfork/cli        # or without installing: npx @greasyfork/cli search bilibili
```

Node 18+. Nothing else — `npm ls @greasyfork/cli` shows only itself. **This is the
recommended install**: the package is ~50 KB, since Node is already on your machine.

No Node around? Grab a prebuilt binary from
[Releases](https://github.com/Weidows/greasyfork-cli/releases) instead — but read
[why they are 60–95 MB](#why-is-the-binary-6095-mb) first:

| Platform | Asset |
|---|---|
| Linux x64 | `gf-linux-x64.tar.gz` |
| Linux arm64 | `gf-linux-arm64.tar.gz` |
| macOS Intel | `gf-darwin-x64.tar.gz` |
| macOS Apple Silicon | `gf-darwin-arm64.tar.gz` |
| Windows x64 | `gf-windows-x64.zip` |

```bash
tar -xzf gf-linux-x64.tar.gz && ./gf search bilibili
```

`SHA256SUMS.txt` is published next to them. On macOS, clear the quarantine flag a browser
download adds — the binaries are ad-hoc signed, but that attribute still has to go:

```bash
xattr -d com.apple.quarantine gf-darwin-arm64
```

## Behind a proxy? Read this first

Greasy Fork is unreachable from mainland China without a proxy, and **`HTTP_PROXY` /
`HTTPS_PROXY` are ignored** by both `node:https` and `fetch`. So `gf` does not depend on them:

1. `GREASYFORK_CLI_PROXY`, `GF_PROXY`, `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`
2. `git config --global https.proxy` — many machines only configure git

If a proxy is found it is used automatically; there is nothing to configure. To be explicit:

```bash
gf --proxy http://127.0.0.1:7890 search bilibili
gf --no-proxy search bilibili          # force a direct connection
```

Only `http://` and `https://` proxies are supported; `socks5://` is rejected loudly rather than
failing silently.

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

gf login                          # sign in (password from a no-echo prompt, or GF_PASSWORD)
gf login --cookie -               # or paste a session cookie from your browser (stdin)
gf whoami                         # is the stored session still valid?
gf publish my.user.js             # publish or update a script
gf publish my.user.js --dry-run   # build the payload and stop, submitting nothing
gf logout                         # forget the local session (browser untouched)
gf logout --server                # sign out everywhere, browser included
```

`<script>` accepts `405130`, `405130-slug`, or a full URL.

| Command | Aliases | What it does |
|---|---|---|
| `search [query]` | `s` | Search; no query returns the top chart |
| `info <script>` | `show` | Author, version, licence, installs, ratings, URLs |
| `download <script>` | `dl` | Save the `.user.js` (`--with-meta` adds `.meta.js`) |
| `cat <script>` | | Print the source, pipe-friendly |
| `versions <script>` | | Every released version |
| `user <id\|slug>` | | All scripts by one author |
| `sites` | | Script count per targeted site |
| `open <script>` | | Print the page URL (`--launch` opens it) |
| `check <path...>` | | Compare local scripts against their `@updateURL` |
| `login` | | Sign in and store the session cookie |
| `logout` | | Forget the stored session |
| `whoami` | | Show the signed-in account |
| `publish <file>` | `push` | Publish a new script, or update an existing one |

### Publishing

```bash
gf login                                  # once; the cookie lasts months
gf publish my.user.js                     # new script, or update when @downloadURL names one
gf publish my.user.js --id 405130         # force the target script id
gf publish my.user.js --dry-run           # fetch the form and build the payload, POST nothing
gf publish my.user.js --type unlisted     # public (default) | unlisted | library
gf publish my.user.js --changelog "fix x" # update note, shown on the script's page
gf publish my.user.js --force             # confirm the site's warnings and resubmit
```

`gf publish` reads `@name`, `@version`, `@match`/`@include` from the file and refuses locally when
the site would refuse anyway — no `@version` bump, no `@match`, a meta block that is missing
entirely. It then:

1. fetches the publish form (create or update) and takes the **fresh** CSRF token from it,
2. POSTs the code to `/<locale>/script_versions` (new) or `/<locale>/scripts/<id>/versions`,
3. decides success from the **redirect target** — `/scripts/<id>-<slug>` means published, while a
   200 that re-renders the form is a rejection, and the server's own error text is printed.

Warnings ("version not incremented", "no namespace", …) are **reported, not swallowed**. They are
the author's own confirmations to make; `--force` ticks them, and nothing else does.

To try it safely: use a throwaway account and an `unlisted` script. This writes to a real account.

There are two ways to sign in, and for some accounts only the second one works.

**Password.** Never an argument — that would land in shell history and, on Windows, in the process
list. It comes from `GF_PASSWORD`, or a no-echo prompt: `readline` with raw mode, which is what
turns off the terminal driver's own echo. (PowerShell `Read-Host -AsSecureString` was tried first
and does not work when spawned from Node — with `-NonInteractive` PowerShell refuses to prompt, and
without it the child still has no console to read from, so it exits non-zero having never asked.
Measured both ways.)

```bash
gf login --email me@example.com      # prompts for the password with echo off
gf login --otp 123456                # with an account that has 2FA enabled
GF_PASSWORD=… gf login               # for scripts; beware the shell history
```

**A pasted session cookie.** The only route in for an account created through GitHub / GitLab /
Google, which can have **no password at all** — the site offers to remove a password and keeps such
accounts from posting until they set up a "secure login". Also the pragmatic choice if you would
rather not hand a password to a CLI.

```bash
# in a logged-in browser tab: DevTools → Application → Cookies → greasyfork.org
# copy the value of _greasyfork_session, then:
gf login --cookie '_greasyfork_session=…'
gf login --cookie -                  # read from stdin, so it stays out of shell history
```

`--cookie` accepts a bare value, a `name=value` pair, or a whole `Cookie:` header, and shrugs off
whether the value is percent-escaped (`Set-Cookie` as the browser received it) or decoded (what
DevTools displays). It is verified against the site before being saved, so a stale cookie fails
immediately with a message saying so rather than at the next publish.

Only the cookie is ever stored, mode 0600, at `%APPDATA%\gf\session.json` on Windows or
`~/.config/gf/session.json` elsewhere (`GF_SESSION` and `GF_CONFIG_DIR` override both).

`gf logout` removes the local file and **nothing else** — it does not touch your browser session.
The site's sign-out calls `invalidate_all_sessions!`, so reaching it would sign you out everywhere;
`gf logout --server` does that deliberately, and says so.

Global flags, accepted before or after the subcommand:

```
--proxy URL     proxy, e.g. http://127.0.0.1:7890 (auto-detected)
--no-proxy      never use a proxy
--timeout SECS  per-request timeout (default 30)
--locale CODE   site locale, e.g. en or zh-CN (default en)
-v, --verbose   log every request
--json          machine-readable output (search / info / versions / user / sites / whoami / publish)
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

## Why is the binary 60–95 MB?

Because it is not really "your program" — it is a whole JavaScript runtime with the program
inside it. Measured on one machine:

| | Size |
|---|---|
| Our code, bundled and minified | **65 KB** |
| A hello-world compiled for Windows | 98.5 MB |
| Our CLI compiled for Windows | 98.5 MB |
| Our CLI, gzipped | 38.2 MB (2.6× smaller) |

The delta between hello-world and the real CLI is **15 KB**, so the size is the runtime, not the
code. Minifying saves 18 KB and `--bytecode` makes the file *larger*.

UPX looks like the answer — it packs the 98 MB binary down to 33 MB (27 MB with `--lzma`) — but
**the result does not run.** Bun appends the JS payload to the end of the executable, and after
UPX the runtime can no longer read it: the packed binary prints Bun's own version instead of
`gf`'s and treats `search` as a script path (`error: Script not found "search"`). `--overlay=copy`
does not help. So UPX is not used here.

That leaves archives as the only honest win, which is why releases ship `.tar.gz` / `.zip`.
**If size matters, install from npm** — ~50 KB, because the runtime is already on your machine.
The binaries exist for machines without Node.

## Notes

- **No API promise:** the endpoints below are undocumented and can change. They are centralised
  in `src/client.ts`.
- **Rate limit:** `robots.txt` asks for `Crawl-delay: 1`. Add delays in loops; prefer the bulk
  `scripts.json` (100 per page) over per-script calls.
- **`gf` is a popular name.** GoFrame's CLI is also `gf`; if both are installed, one shadows the
  other on `PATH`.
- **Publishing has no API.** `gf publish` drives the site's own HTML form instead — that is the
  only way, and it is why the form's field names and the CSRF token are read from the live page on
  every run rather than hard-coded from a spec. A `POST /<locale>/script_versions/prefill` URL also
  exists and needs only the session cookie, but it renders the same form **for a human to submit**,
  so it is not a publish path and `gf` does not use it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `cannot reach https://api.greasyfork.org/...` | No proxy was found. Pass `--proxy http://127.0.0.1:7890`, or set `git config --global https.proxy`. |
| `did not return JSON` with an empty body | A main-site endpoint was hit without following its 308. Only relevant when editing the transport — `src/http.ts` follows redirects. |
| `gf __VERSION__` | The binary was compiled from `src/` without running `npm run build`, so the version placeholder was never stamped. |
| `error: Script not found "search"` | You are running a UPX-packed binary. Bun payloads do not survive UPX. |

## Development

```bash
npm install
npm run typecheck     # tsc over src + tests
npm test              # vitest, offline
npm run build         # tsc -> dist/ + stamp the version from package.json
npm pack --dry-run    # inspect what would be published
```

`scripts/inject-version.mjs` stamps `package.json`'s version into the compiled `__VERSION__`
placeholder, so the published code never resolves `package.json` at runtime (its relative path
changes under `dist/`). It also fails the build if a placeholder survives.

### Building a binary locally

```bash
npm run build
bun build ./dist/cli.js --compile --minify --target=bun-windows-x64 --outfile gf.exe
```

Targets: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`,
`bun-windows-x64`. From Git Bash, pass a native forward-slash path (`C:/...`) — `/c/...` is read
as a relative path.

## Releasing

```bash
npm version patch        # or minor / major, bumps package.json
git push --follow-tags
```

| Workflow file | What it does |
|---|---|
| `.github/workflows/release.yml` | Compiles five platforms, ad-hoc signs the macOS ones, packs archives, writes `SHA256SUMS.txt`, publishes a GitHub Release |
| `.github/workflows/publish-npm.yml` | Publishes `@greasyfork/cli` to npm with provenance |

Both can be started by hand from the Actions tab; each takes the version and fails when it does
not match `package.json`, so a tarball, a binary and an npm version can never disagree.

### Enabling the npm publish

**Option A — npm token.** Create a **Granular Access Token** on npmjs.com: read + write, scoped to
`@greasyfork`, **Bypass 2FA enabled** (the account uses `auth-and-writes`, and a CI runner cannot
type a one-time password). Store it as the repository secret `NPM_TOKEN`.

**Option B — Trusted Publisher (no secret).** Once the package exists on npm, add a Trusted
Publisher in its settings: repository `Weidows/greasyfork-cli`, workflow **`publish-npm.yml`**,
environment **empty** — then delete the `NODE_AUTH_TOKEN` line from the workflow.

> The workflow file name is part of that configuration: renaming `publish-npm.yml` breaks it.

The workflow upgrades npm before publishing (Node 22 ships npm 10.x; trusted publishing needs
npm ≥ 11.5.1) and skips cleanly with a notice when the version is already live.

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

**Biggest gotcha:** `greasyfork.org/<locale>/scripts.json` **ignores** `q` / `page` / `sort` and
always returns the default chart. Search must go through the `api.` subdomain.

Versioned code URLs carry a query string (`.../style.user.js?version=1284070`), so filenames and
`.meta.js` derivation strip it first.
