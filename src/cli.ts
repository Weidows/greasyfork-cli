#!/usr/bin/env node
/**
 * gf — Greasy Fork CLI.
 *
 * A thin shell over the library in this package: search, inspect and download
 * userscripts from the terminal.
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

import {
  booleanValue,
  hasHelpFlag,
  locateSubcommand,
  numberValue,
  parseCommand,
  stringValue,
  type OptDef,
  type ParsedCommand,
  type Values,
} from './args.js';
import { Client, MAIN_SITE, VERSION, type ClientOptions } from './client.js';
import { CookieJar } from './cookie.js';
import { human, orDash, shortDate, table } from './format.js';
import type { ScriptTypeName } from './form.js';
import { looksLikeSignIn } from './htmlform.js';
import { baseName, isNewer, metaFirst, metaUrlFrom, parseScriptId, parseUserscriptMeta, safeFilename } from './meta.js';
import {
  PublishError,
  describeSource,
  inferScriptId,
  inspectSource,
  isFile as isRegularFile,
  publish,
  scriptTypeFromEnv,
} from './publish.js';
import {
  clearSession,
  currentUser,
  describeError,
  loadSession,
  login,
  saveSession,
  sessionCookieFromInput,
  sessionPath,
  SESSION_COOKIE_NAME,
} from './session.js';
import { SORT_NAMES, type Script, type SortName } from './types.js';
import { confirm, isInteractive, prompt, promptHidden, readStdin } from './tty.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

export interface Command {
  name: string;
  aliases: string[];
  usage: string;
  brief: string;
  options: Record<string, OptDef>;
  run: (argv: string[]) => Promise<void>;
}

// --------------------------------------------------------------------------- //
// shared helpers
// --------------------------------------------------------------------------- //

/**
 * The jar of the command currently running, so `main` can persist whatever the
 * session picked up (Rails rotates the session cookie on sign-in and on writes).
 * Read it off the client rather than mirroring state: `Client` always owns a jar.
 */
let activeClient: Client | undefined;
let sessionTouched = false;
/** A jar that must be used instead of whatever is on disk (`gf login --cookie`). */
let jarOverride: CookieJar | undefined;

function buildClient(values: Values, options: { session?: boolean } = {}): Client {
  const clientOptions: ClientOptions = {
    timeoutMs: numberValue(values, 'timeout', 30) * 1000,
  };
  const proxy = stringValue(values, 'proxy');
  if (proxy) clientOptions.proxy = proxy;
  if (booleanValue(values, 'no-proxy')) clientOptions.noProxy = true;
  const locale = values.locale;
  if (typeof locale === 'string') clientOptions.locale = locale;
  if (booleanValue(values, 'verbose')) clientOptions.onRequest = (line) => err(line);

  if (jarOverride) {
    // A pasted session wins over anything on disk.
    clientOptions.jar = jarOverride;
  } else if (options.session) {
    const stored = loadSession();
    if (stored) clientOptions.jar = stored;
    // Even with nothing on disk the client gets a jar of its own, and the login
    // page's own cookies land in it — which is what makes a FIRST-ever login
    // work. Without that, the CSRF POST arrives with no session and gets a 422.
    sessionTouched = true;
  }
  const client = new Client(clientOptions);
  if (options.session || jarOverride) activeClient = client;
  return client;
}

/**
 * Requires a stored session, with one clear message instead of a broken publish.
 *
 * Checks the file rather than `client.jar`: a client owns a jar either way, and an
 * empty one would sail past a presence check and fail later with a confusing 422.
 */
function requireSession(values: Values): Client {
  const client = buildClient(values, { session: true });
  if (loadSession() === undefined && !jarOverride) {
    throw new Error(`not signed in — run \`gf login\` first (session file: ${sessionPath()})`);
  }
  return client;
}

/** Parse a command's args, handling `--help` uniformly. */
function parse(cmd: Command, argv: string[]): ParsedCommand {
  if (hasHelpFlag(argv)) {
    out(`usage: gf ${cmd.usage}`);
    out('');
    out(cmd.brief);
    out('');
    out('Global flags: --proxy URL | --no-proxy | --timeout SECS | --locale CODE | -v | -h');
    process.exit(0);
  }
  return parseCommand(argv, cmd.options);
}

function requirePositional(positionals: string[], usage: string): string {
  const first = positionals[0];
  if (!first) throw new Error(`usage: gf ${usage}`);
  return first;
}

function printJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

/** Open a URL in the default browser (best effort). */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => err(`could not open browser: ${e.message}`));
  child.unref();
}

const scriptId = (value: string): number => {
  try {
    return parseScriptId(value);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
};

// --------------------------------------------------------------------------- //
// commands
// --------------------------------------------------------------------------- //

async function cmdSearch(argv: string[]): Promise<void> {
  const { values, positionals } = parse(searchCommand, argv);
  const sort = stringValue(values, 'sort', 'relevant');
  if (!(SORT_NAMES as string[]).includes(sort)) {
    throw new Error(`unknown --sort ${JSON.stringify(sort)} (expected ${SORT_NAMES.join(', ')})`);
  }
  const limit = Math.min(Math.max(numberValue(values, 'limit', 20), 1), 100);
  const page = numberValue(values, 'page', 1);
  const site = stringValue(values, 'site');

  const client = buildClient(values);
  const result = await client.search({
    query: positionals[0],
    page,
    perPage: limit,
    sort: sort as SortName,
    site: site || undefined,
  });

  if (booleanValue(values, 'json')) {
    printJson(result.query);
    return;
  }
  const scripts = result.query.slice(0, limit);
  if (scripts.length === 0) {
    out(`no scripts matched ${JSON.stringify(positionals[0] ?? '')}`);
    return;
  }
  out(
    table(
      ['ID', 'Name', 'Author', 'Daily', 'Total', 'Fan', 'Updated'],
      scripts.map((s) => [
        String(s.id),
        s.name,
        s.users.map((u) => u.name).join(', '),
        human(s.daily_installs),
        human(s.total_installs),
        orDash(s.fan_score === null ? null : String(s.fan_score ?? '')),
        shortDate(s.code_updated_at),
      ]),
      { 1: 52, 2: 18 },
    ),
  );
  out(`${scripts.length} shown (page ${page}) · ${client.apiHost}`);
}

async function cmdInfo(argv: string[]): Promise<void> {
  const { values, positionals } = parse(infoCommand, argv);
  const id = scriptId(requirePositional(positionals, 'info <script>'));
  const client = buildClient(values);
  const script = await client.script(id);

  if (booleanValue(values, 'json')) {
    printJson(script);
    return;
  }
  out(`${script.name}  [id ${script.id}]`);
  const authors = script.users.map((u) => u.name).join(', ');
  if (authors) out(`Author     : ${authors}`);
  const rows: Array<[string, string | null | undefined]> = [
    ['Version', script.version],
    ['Locale', script.locale],
    ['License', script.license],
    ['Namespace', script.namespace],
    ['Created', script.created_at],
    ['Updated', script.code_updated_at],
  ];
  for (const [label, value] of rows) {
    if (value) out(`${label.padEnd(11)}: ${value}`);
  }
  if (script.code_size) out(`${'Code size'.padEnd(11)}: ${human(script.code_size)}`);
  out(
    `${'Installs'.padEnd(11)}: ${script.daily_installs} daily / ${script.total_installs} total · ` +
      `fan ${orDash(script.fan_score === null ? null : String(script.fan_score ?? ''))} · ` +
      `ratings ${script.good_ratings}★ ${script.ok_ratings}~ ${script.bad_ratings}✗`,
  );
  if (script.description) out(`\n${script.description}`);
  out(`\nPage    : ${client.mainSite}/scripts/${script.id}`);
  out(`Install : ${script.code_url ?? '-'}`);
  if (script.code_url) out(`Meta    : ${metaUrlFrom(script.code_url)}`);
}

async function cmdDownload(argv: string[]): Promise<void> {
  const { values, positionals } = parse(downloadCommand, argv);
  const id = scriptId(requirePositional(positionals, 'download <script> [-o DIR]'));
  const version = stringValue(values, 'version');
  const client = buildClient(values);

  const resolved = await client.codeUrl(id, version || undefined);
  if (!resolved.codeUrl) throw new Error(`script ${id} has no downloadable code (deleted?)`);
  const codeUrl = resolved.codeUrl;

  let name = baseName(codeUrl);
  if (booleanValue(values, 'short-name') && resolved.script) {
    const slug = resolved.script.url.slice(resolved.script.url.lastIndexOf('/') + 1);
    const dash = slug.indexOf('-');
    if (dash >= 0) {
      const ext = name.endsWith('.user.css') ? '.user.css' : '.user.js';
      name = `${id}-${decodeURIComponent(slug.slice(dash + 1))}${ext}`;
    }
  }
  name = safeFilename(name);

  const dir = stringValue(values, 'output', '.');
  const dest = join(dir, name);
  const body = await client.raw(codeUrl);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  out(`saved ${dest}  (${Buffer.byteLength(body)} bytes)`);

  if (booleanValue(values, 'with-meta')) {
    const metaDest = join(dir, metaNameFor(name));
    const metaBody = await client.raw(metaUrlFrom(codeUrl));
    writeFileSync(metaDest, metaBody);
    out(`saved ${metaDest}  (${Buffer.byteLength(metaBody)} bytes)`);
  }
}

function metaNameFor(name: string): string {
  if (name.endsWith('.user.js')) return `${name.slice(0, -'.user.js'.length)}.meta.js`;
  if (name.endsWith('.user.css')) return `${name.slice(0, -'.user.css'.length)}.meta.css`;
  return `${name}.meta.js`;
}

async function cmdCat(argv: string[]): Promise<void> {
  const { values, positionals } = parse(catCommand, argv);
  const id = scriptId(requirePositional(positionals, 'cat <script>'));
  const client = buildClient(values);
  const resolved = await client.codeUrl(id, stringValue(values, 'version') || undefined);
  process.stdout.write(await client.raw(resolved.codeUrl));
}

async function cmdVersions(argv: string[]): Promise<void> {
  const { values, positionals } = parse(versionsCommand, argv);
  const id = scriptId(requirePositional(positionals, 'versions <script>'));
  const client = buildClient(values);
  const versions = await client.versions(id);
  if (booleanValue(values, 'json')) {
    printJson(versions);
    return;
  }
  out(
    table(
      ['Version', 'Created', 'Code URL'],
      versions.map((v) => [v.version, shortDate(v.created_at), v.code_url]),
      { 2: 60 },
    ),
  );
}

async function cmdUser(argv: string[]): Promise<void> {
  const { values, positionals } = parse(userCommand, argv);
  const who = requirePositional(positionals, 'user <id|slug>');
  const client = buildClient(values);
  const user = await client.user(who);
  if (booleanValue(values, 'json')) {
    printJson(user);
    return;
  }
  out(`${user.name}  [id ${user.id}] · joined ${shortDate(user.created_at)}`);
  out(`page: ${user.url}`);
  out('');
  out(
    table(
      ['ID', 'Name', 'Daily', 'Total', 'Fan', 'Updated'],
      user.scripts.map((s: Script) => [
        String(s.id),
        s.name,
        human(s.daily_installs),
        human(s.total_installs),
        orDash(s.fan_score === null ? null : String(s.fan_score ?? '')),
        shortDate(s.code_updated_at),
      ]),
      { 1: 56 },
    ),
  );
}

async function cmdSites(argv: string[]): Promise<void> {
  const { values } = parse(sitesCommand, argv);
  const client = buildClient(values);
  const sites = await client.sites();
  if (booleanValue(values, 'json')) {
    printJson(sites);
    return;
  }
  const ranked = Object.entries(sites)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, numberValue(values, 'limit', 30)));
  out(table(['Site', 'Scripts'], ranked.map(([site, n]) => [site, String(n)]), { 0: 60 }));
  out(`${ranked.length} shown`);
}

async function cmdOpen(argv: string[]): Promise<void> {
  const { values, positionals } = parse(openCommand, argv);
  const id = scriptId(requirePositional(positionals, 'open <script>'));
  // <site>/scripts/<id> redirects to the canonical <id>-<slug> URL, so the short
  // form is both readable and correct — and needs no request.
  const url = `${MAIN_SITE}/scripts/${id}`;
  out(url);
  if (booleanValue(values, 'launch')) openBrowser(url);
}

async function cmdCheck(argv: string[]): Promise<void> {
  const { values, positionals } = parse(checkCommand, argv);
  if (positionals.length === 0) throw new Error('usage: gf check <path...>');
  const client = buildClient(values);

  const files: string[] = [];
  for (const target of positionals) {
    let isDir = false;
    try {
      isDir = statSync(target).isDirectory();
    } catch {
      out(`skip (not found): ${target}`);
      continue;
    }
    if (!isDir) {
      files.push(target);
      continue;
    }
    for (const entry of readdirSync(target).sort()) {
      if (entry.endsWith('.user.js') || entry.endsWith('.user.css')) files.push(join(target, entry));
    }
  }
  if (files.length === 0) throw new Error('no .user.js files found to check');

  const rows: string[][] = [];
  let outdated = 0;
  for (const file of files) {
    const label = basename(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      rows.push([label, '?', '-', '', 'read error']);
      continue;
    }
    const local = orDash(metaFirst(parseUserscriptMeta(source), 'version'));
    const updateUrl = metaFirst(parseUserscriptMeta(source), 'updateurl') || metaFirst(parseUserscriptMeta(source), 'downloadurl');
    if (!updateUrl) {
      rows.push([label, local, '-', '', 'no @updateURL']);
      continue;
    }
    let remote: string;
    try {
      remote = orDash(metaFirst(parseUserscriptMeta(await client.raw(updateUrl)), 'version'));
    } catch {
      rows.push([label, local, '-', '', 'fetch error']);
      continue;
    }
    const status = isNewer(remote, local) ? 'UPDATE' : 'ok';
    if (status === 'UPDATE') outdated++;
    rows.push([label, local, remote, '', status]);
  }
  out(table(['File', 'Local', 'Remote', '', 'Status'], rows, { 0: 46 }));
  out(`${files.length} checked · ${outdated} outdated`);
}

// --------------------------------------------------------------------------- //
// session + write commands
// --------------------------------------------------------------------------- //

/**
 * The password, from the environment or a hidden prompt.
 *
 * Never from argv: Windows exposes the full command line to any process, and
 * every shell writes it to history.
 */
async function readPassword(email: string): Promise<string> {
  const fromEnv = process.env.GF_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!isInteractive()) {
    throw new Error(
      'no password available: set GF_PASSWORD, or run `gf login` from a terminal so it can prompt',
    );
  }
  return promptHidden(`Password for ${email}: `);
}

async function readEmail(explicit: string): Promise<string> {
  const fromEnv = process.env.GF_EMAIL;
  if (explicit) return explicit;
  if (fromEnv) return fromEnv;
  if (!isInteractive()) {
    throw new Error('no e-mail available: pass --email or set GF_EMAIL');
  }
  const answer = await prompt('Greasy Fork e-mail: ');
  if (!answer) throw new Error('no e-mail given');
  return answer;
}

async function cmdLogin(argv: string[]): Promise<void> {
  const { values } = parse(loginCommand, argv);

  const cookieArg = stringValue(values, 'cookie');
  if (cookieArg) {
    await loginWithCookie(values, cookieArg);
    return;
  }

  const client = buildClient(values, { session: true });
  const email = await readEmail(stringValue(values, 'email'));
  const password = await readPassword(email);
  const otp = stringValue(values, 'otp') || undefined;

  const result = await login(client, email, password, otp);
  const jar = client.jar;
  if (jar.size === 0) throw new Error('the site accepted the login but set no session cookie');
  saveSession(jar, result.username);

  out(`signed in as ${result.username || email}`);
  out(`session : ${sessionPath()}`);
  out(`cookies : ${jar.size}`);
}

/**
 * Sign in with a session cookie copied out of a browser.
 *
 * The only route for an account created through GitHub / GitLab / Google: such an
 * account can have no password at all, so the e-mail-and-password path can never
 * succeed for it. Also the pragmatic choice for anyone who would rather not hand a
 * password to a CLI.
 *
 * `--cookie -` reads stdin, which keeps the value out of the shell history and,
 * on Windows, out of the process list — prefer it over an inline argument.
 */
async function loginWithCookie(values: Values, cookieArg: string): Promise<void> {
  const raw = cookieArg === '-' ? await readStdin() : cookieArg;
  const cookie = sessionCookieFromInput(raw);
  if (!cookie) {
    throw new Error(
      `no cookie value given — copy the value of ${SESSION_COOKIE_NAME} from a logged-in greasyfork.org tab`,
    );
  }

  const jar = new CookieJar();
  jar.set(cookie);
  jarOverride = jar;
  const client = buildClient(values, { session: true });
  const username = await currentUser(client);
  if (username === null) {
    throw new Error(
      'that cookie was rejected — copy a fresh _greasyfork_session from a logged-in greasyfork.org tab ' +
        '(EditThisCookie / DevTools → Application → Cookies)',
    );
  }

  saveSession(jar, username);
  out(`signed in as ${username || 'unknown'} (pasted session)`);
  out(`session : ${sessionPath()}`);
  out('note    : this lasts as long as that browser session does; re-copy when it expires');
}

async function cmdLogout(argv: string[]): Promise<void> {
  const { values } = parse(logoutCommand, argv);

  let note = '';
  if (booleanValue(values, 'server')) {
    // Destructive on purpose, hence opt-in: SessionsController#destroy calls
    // `invalidate_all_sessions!`, so this signs the account out EVERYWHERE —
    // including the browser the user is logged into. Local-only is the default
    // precisely so a routine `gf logout` cannot take the browser with it.
    const client = buildClient(values, { session: true });
    if (client.jar.size > 0) {
      const url = `${client.mainSite}/${client.locale}/users/sign_out`;
      const res = await client.fetchHtml(url);
      if (!looksLikeSignIn(res.body)) {
        throw new Error(`the site did not confirm the sign-out (ended up at ${res.finalUrl})`);
      }
      note = ' · all sessions for that account were invalidated — your browser is signed out too';
    }
  }

  const removed = clearSession();
  out(
    removed
      ? `signed out locally${note} (removed ${sessionPath()})`
      : 'no stored session to remove',
  );
}

async function cmdWhoami(argv: string[]): Promise<void> {
  const { values } = parse(whoamiCommand, argv);
  const client = buildClient(values, { session: true });
  const json = booleanValue(values, 'json');

  if (loadSession() === undefined && !jarOverride) {
    if (json) printJson({ signedIn: false, sessionFile: sessionPath() });
    else out('not signed in');
    return;
  }
  const name = await currentUser(client);
  if (json) {
    printJson({ signedIn: name !== null, username: name || null, sessionFile: sessionPath() });
    return;
  }
  if (name === null) {
    out('not signed in (the stored session was rejected — run `gf login` again)');
    return;
  }
  out(name ? `signed in as ${name}` : 'signed in');
}

async function cmdPublish(argv: string[]): Promise<void> {
  const { values, positionals } = parse(publishCommand, argv);
  const target = requirePositional(positionals, 'publish <file.user.js> [--id N]');
  if (!isRegularFile(target)) throw new Error(`not a file: ${target}`);

  const { info } = inspectSource(target);
  const client = requireSession(values);

  const explicitId = stringValue(values, 'id');
  const scriptType = (stringValue(values, 'type') || scriptTypeFromEnv()) as
    | ScriptTypeName
    | '';
  if (scriptType && !['public', 'unlisted', 'library'].includes(scriptType)) {
    throw new Error(`unknown --type ${JSON.stringify(scriptType)} (public, unlisted, library)`);
  }

  const inferred = scriptType ? undefined : inferScriptId(info);
  const id = explicitId ? scriptId(explicitId) : inferred;
  const json = booleanValue(values, 'json');
  const dryRun = booleanValue(values, 'dry-run');
  const force = booleanValue(values, 'force');

  if (!id && !force && !dryRun) {
    const proceed = await confirm(
      `${info.name} ${info.version} is not on Greasy Fork yet — create it as a new script?`,
    );
    if (!proceed) throw new Error('cancelled');
  }

  const step = (line: string) => {
    if (!json) err(`  ${line}`);
  };
  if (!json) {
    out(`${id ? 'updating' : 'creating'} ${describeSource(info, target)}`);
    if (id) out(`target  : ${client.mainSite}/${client.locale}/scripts/${id}`);
  }

  const result = await publish(client, target, {
    ...(id ? { scriptId: id } : {}),
    ...(scriptType ? { scriptType: scriptType as ScriptTypeName } : {}),
    ...(stringValue(values, 'changelog') ? { changelog: stringValue(values, 'changelog') } : {}),
    ...(stringValue(values, 'info') ? { additionalInfo: stringValue(values, 'info') } : {}),
    force,
    dryRun,
    onStep: step,
  });

  if (json) {
    printJson(result);
    return;
  }
  if (result.dryRun) {
    out('dry run: the form was fetched and the payload built; nothing was submitted');
    return;
  }
  out(`${result.created ? 'published' : 'updated'} ${result.name} ${result.version}`);
  out(`url     : ${result.url}`);
  if (result.overrides.length > 0) {
    out(`warnings: confirmed ${result.overrides.length} (${result.overrides.join(', ')})`);
  }
  out('note    : the site may hold a new script for review before it is listed');
}

// --------------------------------------------------------------------------- //
// command table + entry point
// --------------------------------------------------------------------------- //

const jsonOption: Record<string, OptDef> = { json: { type: 'boolean' } };

export const searchCommand: Command = {
  name: 'search',
  aliases: ['s'],
  usage: 'search [query] [-n N] [--sort S] [--site D] [--json]',
  brief: 'search scripts (no query = top chart)',
  options: {
    page: { type: 'string', short: 'p' },
    limit: { type: 'string', short: 'n' },
    sort: { type: 'string' },
    site: { type: 'string' },
    ...jsonOption,
  },
  run: cmdSearch,
};

const infoCommand: Command = {
  name: 'info',
  aliases: ['show'],
  usage: 'info <script> [--json]',
  brief: 'show script details',
  options: { ...jsonOption },
  run: cmdInfo,
};

const downloadCommand: Command = {
  name: 'download',
  aliases: ['dl'],
  usage: 'download <script> [-o DIR] [--version V] [--with-meta] [--short-name]',
  brief: 'download the .user.js (and .meta.js)',
  options: {
    output: { type: 'string', short: 'o' },
    version: { type: 'string' },
    'with-meta': { type: 'boolean' },
    'short-name': { type: 'boolean' },
  },
  run: cmdDownload,
};

const catCommand: Command = {
  name: 'cat',
  aliases: [],
  usage: 'cat <script> [--version V]',
  brief: 'print script source to stdout',
  options: { version: { type: 'string' } },
  run: cmdCat,
};

const versionsCommand: Command = {
  name: 'versions',
  aliases: [],
  usage: 'versions <script> [--json]',
  brief: 'list released versions',
  options: { ...jsonOption },
  run: cmdVersions,
};

const userCommand: Command = {
  name: 'user',
  aliases: [],
  usage: 'user <id|slug> [--json]',
  brief: "list a user's published scripts",
  options: { ...jsonOption },
  run: cmdUser,
};

const sitesCommand: Command = {
  name: 'sites',
  aliases: [],
  usage: 'sites [-n N] [--json]',
  brief: 'list sites that scripts target',
  options: { limit: { type: 'string', short: 'n' }, ...jsonOption },
  run: cmdSites,
};

const openCommand: Command = {
  name: 'open',
  aliases: [],
  usage: 'open <script> [--launch]',
  brief: 'print the script page URL',
  options: { launch: { type: 'boolean' } },
  run: cmdOpen,
};

const checkCommand: Command = {
  name: 'check',
  aliases: [],
  usage: 'check <path...>',
  brief: 'check local userscripts for updates',
  options: {},
  run: cmdCheck,
};

const loginCommand: Command = {
  name: 'login',
  aliases: [],
  usage: 'login [--email ME] [--otp CODE] | login --cookie <VALUE|-]',
  brief: 'sign in and store the session cookie',
  options: {
    email: { type: 'string' },
    otp: { type: 'string' },
    cookie: { type: 'string' },
  },
  run: cmdLogin,
};

const logoutCommand: Command = {
  name: 'logout',
  aliases: [],
  usage: 'logout [--server]',
  brief: 'forget the stored session (local only, unless --server)',
  options: { server: { type: 'boolean' } },
  run: cmdLogout,
};

const whoamiCommand: Command = {
  name: 'whoami',
  aliases: [],
  usage: 'whoami [--json]',
  brief: 'show the signed-in account',
  options: { ...jsonOption },
  run: cmdWhoami,
};

const publishCommand: Command = {
  name: 'publish',
  aliases: ['push'],
  usage:
    'publish <file.user.js> [--id N] [--type public|unlisted|library] [--changelog T] [--info T]\n' +
    '                    [--force] [--dry-run] [--json]',
  brief: 'publish or update a script (needs login)',
  options: {
    id: { type: 'string' },
    type: { type: 'string' },
    changelog: { type: 'string' },
    info: { type: 'string' },
    force: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    ...jsonOption,
  },
  run: cmdPublish,
};

export const COMMANDS: Command[] = [
  searchCommand,
  infoCommand,
  downloadCommand,
  catCommand,
  versionsCommand,
  userCommand,
  sitesCommand,
  openCommand,
  checkCommand,
  loginCommand,
  logoutCommand,
  whoamiCommand,
  publishCommand,
];

function usage(): void {
  out('gf — search, inspect, download and publish Greasy Fork userscripts');
  out('');
  out('Usage:');
  out('  gf [global flags] <command> [flags] [args]');
  out('');
  out('Commands:');
  for (const c of COMMANDS) out(`  ${c.usage.padEnd(74)} ${c.brief}`);
  out('');
  out('Global flags:');
  out('  --proxy URL     proxy, e.g. http://127.0.0.1:7890 (auto-detected from');
  out('                  env / git config https.proxy)');
  out('  --no-proxy      disable proxy use entirely');
  out('  --timeout SECS  per-request timeout (default 30)');
  out('  --locale CODE   site locale, e.g. en or zh-CN (default en)');
  out('  -v, --verbose   log requests to stderr');
  out('  -h, --help      show help');
  out('      --version   print version');
  out('');
  out('Reads: api.greasyfork.org (JSON) · update.greasyfork.org (raw code)');
  out('Login/publish: the site\'s own HTML forms — unofficial, needs a session cookie');
  out('  password is read from GF_PASSWORD or a hidden prompt, never from argv');
  out(`  session file: ${sessionPath()}`);
}

function findCommand(name: string | undefined): Command | undefined {
  if (!name) return undefined;
  return COMMANDS.find((c) => c.name === name || c.aliases.includes(name));
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    usage();
    return;
  }
  const first = argv[0]!;

  // A bare global flag with no subcommand, e.g. `gf -h` / `gf --version`.
  if (first === '-h' || first === '--help') {
    usage();
    return;
  }
  if (first === '--version' || first === 'version') {
    out(`gf ${VERSION}`);
    return;
  }
  if (first === 'help') {
    const target = findCommand(argv[1]);
    if (target) {
      out(`usage: gf ${target.usage}`);
      out('');
      out(target.brief);
    } else {
      usage();
    }
    return;
  }

  // Tolerate global flags written before the subcommand.
  let command = findCommand(first);
  if (!command) {
    const { sub } = locateSubcommand(argv); // throws on an unknown leading flag
    command = findCommand(sub);
  }
  if (!command) {
    usage();
    throw new Error(`unknown command ${JSON.stringify(first)}`);
  }
  await command.run(argv);

  // A command that carried a session may have rotated the cookie (Rails issues a
  // new one on sign-in and on writes), so persist whatever the jar now holds.
  if (sessionTouched && activeClient) saveSession(activeClient.jar);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  if (e instanceof PublishError && e.problems.length > 0) {
    err(`error: ${e.message}`);
    for (const problem of e.problems) err(`  - ${problem}`);
    process.exit(1);
  }
  err(`error: ${describeError(e)}`);
  process.exit(1);
});
