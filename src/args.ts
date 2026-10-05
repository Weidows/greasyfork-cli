/**
 * Argument parsing.
 *
 * Built on `node:util` `parseArgs` (no dependency) — but with one addition the
 * stdlib does not cover: global flags written BEFORE the subcommand must reach
 * the subcommand. `gfc --locale zh-CN search video` parses the leading flag,
 * then the command parses only its own tail, so the value would be silently
 * dropped unless it is captured and merged here.
 *
 * `parseArgs` itself already tolerates interleaving (`gfc download 405130 -o dir`
 * keeps `-o`), which the earlier Go port needed a hand-written parser for.
 */

import { parseArgs } from 'node:util';

export type OptDef = { type: 'string' | 'boolean'; short?: string };
export type Values = Record<string, unknown>;

/** Options accepted before OR after the subcommand. */
export const GLOBAL_OPTIONS: Record<string, OptDef> = {
  proxy: { type: 'string' },
  'no-proxy': { type: 'boolean' },
  timeout: { type: 'string' },
  locale: { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
};

export interface LocatedArgs {
  /** The subcommand, when one was found. */
  sub: string | undefined;
  /** Everything after the subcommand. */
  rest: string[];
  /** Values of the global flags that came before the subcommand. */
  inherited: Values;
}

/**
 * Split `argv` into (inherited global flags, subcommand, remaining args).
 * Throws on an unknown flag before the subcommand, so a typo cannot be swallowed.
 */
export function locateSubcommand(argv: string[]): LocatedArgs {
  const shortIndex = new Map<string, [string, OptDef]>();
  for (const [name, def] of Object.entries(GLOBAL_OPTIONS)) {
    if (def.short) shortIndex.set(def.short, [name, def]);
  }

  const inherited: Values = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      i++;
      break;
    }
    if (!token.startsWith('-') || token === '-') break;

    const isLong = token.startsWith('--');
    let name = token.replace(/^--?/, '');
    let inline: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    const found = isLong ? lookupLong(name) : shortIndex.get(name);
    if (!found) throw new Error(`unknown flag: ${token}`);
    const [canonical, def] = found;

    if (def.type === 'boolean') {
      inherited[canonical] = true;
      continue;
    }
    if (inline !== undefined) {
      inherited[canonical] = inline;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined) throw new Error(`flag --${canonical} needs a value`);
    inherited[canonical] = next;
    i++;
  }

  return { sub: argv[i], rest: argv.slice(i + 1), inherited };
}

function lookupLong(name: string): [string, OptDef] | undefined {
  const def = GLOBAL_OPTIONS[name];
  return def ? [name, def] : undefined;
}

export interface ParsedCommand {
  sub: string | undefined;
  values: Values;
  positionals: string[];
}

/**
 * Parse one command's arguments, then fill in any global flag the command did
 * not set itself (command-local flags always win over inherited ones).
 */
export function parseCommand(
  argv: string[],
  commandOptions: Record<string, OptDef> = {},
): ParsedCommand {
  const { sub, rest, inherited } = locateSubcommand(argv);
  const parsed = parseArgs({
    args: rest,
    options: { ...commandOptions, ...GLOBAL_OPTIONS },
    allowPositionals: true,
    strict: true,
  });
  return {
    sub,
    values: { ...inherited, ...parsed.values },
    positionals: parsed.positionals,
  };
}

/** Read a string flag, falling back to `fallback`. */
export function stringValue(values: Values, key: string, fallback = ''): string {
  const raw = values[key];
  return typeof raw === 'string' ? raw : fallback;
}

/** Read a boolean flag. */
export function booleanValue(values: Values, key: string): boolean {
  return values[key] === true;
}

/** Read a numeric flag, falling back to `fallback` when absent or unparsable. */
export function numberValue(values: Values, key: string, fallback: number): number {
  const raw = values[key];
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Whether `-h` / `--help` appears anywhere in the args. */
export function hasHelpFlag(argv: string[]): boolean {
  return argv.some((a) => a === '-h' || a === '--help');
}
