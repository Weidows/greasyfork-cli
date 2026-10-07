/**
 * Terminal prompts, with no dependency.
 *
 * The password must never arrive as a command-line argument: Windows puts the
 * whole command line in the process list, and on every platform a shell writes
 * it to history. So it is read from `GF_PASSWORD`, or typed at a no-echo prompt.
 *
 * The no-echo prompt is plain `readline`, not a child process. Borrowing the OS's
 * own facility was tried first and does not work:
 *
 *  - PowerShell `Read-Host -AsSecureString` spawned from Node: with
 *    `-NonInteractive` PowerShell refuses to prompt at all, and **without it the
 *    child still has no console to read from** — it exits non-zero with an empty
 *    stderr, so the user sees "could not read the password" without ever being
 *    asked for one. Measured both ways on Windows 11 from Git Bash.
 *  - `stty -echo` via `sh`: the same shape of problem, plus `/dev/tty`
 *    assumptions that MinTTY-style terminals do not satisfy.
 *
 * `readline` with `terminal: true` is what works, and it is already proven on the
 * user's machine: the e-mail prompt uses it. Raw mode turns off the terminal
 * driver's own echo, and pointing readline's output at a sink discards the line it
 * would otherwise redraw. No subprocess, no platform branch, no internals.
 */

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Whether an interactive prompt is possible at all. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Piped-input line reader.
 *
 * A fresh `readline` interface per prompt looks fine but silently drops
 * look-ahead: readline buffers whatever arrived in the same chunk, and closing
 * the interface discards it. With `printf 'email\npassword\n' | gf login` the
 * e-mail prompt consumed both lines and the password prompt then hung forever.
 * So non-TTY input is read here instead, where the leftover stays put.
 */
let buffered = '';
let stdinEnded = false;
let stdinReady = false;
let waiting: ((line: string | null) => void) | undefined;

function deliver(): void {
  if (!waiting) return;
  const newline = buffered.indexOf('\n');
  if (newline >= 0) {
    const line = buffered.slice(0, newline).replace(/\r$/, '');
    buffered = buffered.slice(newline + 1);
    const resolve = waiting;
    waiting = undefined;
    resolve(line);
  } else if (stdinEnded) {
    const resolve = waiting;
    waiting = undefined;
    resolve(buffered.length > 0 ? buffered : null);
    buffered = '';
  }
}

function readPipedLine(): Promise<string | null> {
  if (!stdinReady) {
    stdinReady = true;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffered += chunk;
      deliver();
    });
    process.stdin.on('end', () => {
      stdinEnded = true;
      deliver();
    });
  }
  return new Promise<string | null>((resolve) => {
    waiting = resolve;
    deliver();
  });
}

/** Read one line, with echo when that means anything. */
export async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    return ((await readPipedLine()) ?? '').trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

/** Ask a yes/no question; anything but an explicit yes is a no. */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!isInteractive()) return defaultYes;
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await prompt(`${question}${suffix}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/** Read all of stdin, for `--flag -` style input. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk as string);
  return chunks.join('');
}

/** A write-only sink: readline redraws the line here instead of on screen. */
const sink = new Writable({
  write(_chunk: unknown, _encoding: unknown, callback: () => void): void {
    callback();
  },
});

/**
 * Read a line with the typed characters shown as `*`.
 *
 * Not zero feedback: the user must be able to see that their keystrokes landed.
 * Nothing sensitive is printed — a fixed-width mask per character, never the
 * character itself — and Backspace shrinks the mask so a correction is visible.
 * (Fully hidden is safer against shoulder-surfing but is worse UX and does not
 * tell the user whether the keyboard, paste or IME actually worked.)
 *
 * With no TTY there is nothing to mask, so a piped stdin is read directly and
 * `echo "$PW" | gf login` keeps working.
 */
export async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    return (await readPipedLine()) ?? '';
  }

  process.stdout.write(question);
  let masked = 0;
  const rl = createInterface({
    input: process.stdin,
    // `terminal: true` enables raw mode, and raw mode is what suppresses the
    // terminal driver's echo; the sink swallows readline's own redraw of the line.
    output: sink,
    terminal: true,
    historySize: 0,
  });

  // Re-render the mask ourselves: the value never reaches the output stream, only
  // one `*` per character typed.
  const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
    if (!key) return;
    if (key.name === 'backspace') {
      if (masked > 0) {
        masked--;
        process.stdout.write('\b \b');
      }
      return;
    }
    if (key.name === 'return' || key.name === 'enter') return;
    // Arrow keys, Tab, etc. move no characters.
    if (STRINGS_NOTHING_SPECIAL.has(key.name)) return;
    masked++;
    process.stdout.write('*');
  };
  process.stdin.on('keypress', onKeypress);

  // In raw mode Ctrl+C arrives as a keystroke instead of a signal, so without a
  // listener it would be swallowed and the user could not abort. Put the cursor
  // somewhere sane and exit with the conventional code.
  const onSigint = (): never => {
    rl.close();
    process.stdout.write('\n');
    process.exit(130);
  };
  rl.on('SIGINT', onSigint);

  try {
    return await new Promise<string>((resolve) => {
      rl.question('', (answer) => resolve(answer));
    });
  } finally {
    process.stdin.removeListener('keypress', onKeypress);
    rl.removeListener('SIGINT', onSigint);
    rl.close();
    // The newline readline would have written went to the sink, and the masked
    // input still deserves a visible line break.
    process.stdout.write('\n');
  }
}

/** Key names that produce no character, so they must not grow the mask. */
const STRINGS_NOTHING_SPECIAL = new Set<string | undefined>([
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'tab',
  'escape',
  'insert',
  'delete',
  'shift',
  'ctrl',
  'alt',
  'meta',
  'capslock',
  'numlock',
  'scrolllock',
  'pause',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
]);
