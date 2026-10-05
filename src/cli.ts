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
import { human, orDash, shortDate, table } from './format.js';
import { baseName, isNewer, metaFirst, metaUrlFrom, parseScriptId, parseUserscriptMeta, safeFilename } from './meta.js';
import { SORT_NAMES, type Script, type SortName } from './types.js';

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

function buildClient(values: Values): Client {
  const options: ClientOptions = {
    timeoutMs: numberValue(values, 'timeout', 30) * 1000,
  };
  const proxy = stringValue(values, 'proxy');
  if (proxy) options.proxy = proxy;
  if (booleanValue(values, 'no-proxy')) options.noProxy = true;
  const locale = values.locale;
  if (typeof locale === 'string') options.locale = locale;
  if (booleanValue(values, 'verbose')) options.onRequest = (line) => err(line);
  return new Client(options);
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
];

function usage(): void {
  out('gf — search, inspect and download Greasy Fork userscripts');
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
  out('Endpoints: api.greasyfork.org (JSON) · update.greasyfork.org (raw code)');
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
}

main(process.argv.slice(2)).catch((e: unknown) => {
  err(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
