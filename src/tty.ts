/**
 * Terminal prompts, with no dependency.
 *
 * The password must never arrive as a command-line argument: Windows puts the
 * whole command line in the process list, and on every platform a shell writes
 * it to history. So it is read from `GF_PASSWORD`, or typed at a hidden prompt.
 *
 * A hidden prompt cannot be done in pure Node on Windows — there is no
 * `readline` hook for "don't echo" — so the OS's own facility is used: PowerShell
 * `Read-Host -AsSecureString` there, `stty -echo` elsewhere.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Whether an interactive prompt is possible at all. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Read one line from stdin with echo on (email addresses, OTP codes, confirms). */
export async function prompt(question: string): Promise<string> {
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

/** Read a line with the typed characters hidden. */
export function promptHidden(question: string): Promise<string> {
  if (!isInteractive()) {
    // Not a terminal: a piped stdin is the only option left, and echoing is
    // moot because nothing is showing.
    return prompt(question);
  }
  return process.platform === 'win32'
    ? promptHiddenWindows(question)
    : promptHiddenPosix(question);
}

/**
 * PowerShell reads the value into a `SecureString` and writes the plaintext to
 * stdout. Nothing is echoed and nothing lands in the command line, because the
 * prompt text is the only thing passed in.
 */
function promptHiddenWindows(question: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$sec = Read-Host -AsSecureString -Prompt ${psQuote(question)}`,
      '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)',
      'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) }',
      'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.replace(/\r?\n$/, ''));
      else reject(new Error(`could not read the password (powershell exited ${code})`));
    });
  });
}

/** Escape a string as a single-quoted PowerShell literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * `stty -echo` around a read from the controlling terminal.
 *
 * `/dev/tty` rather than stdin so a piped stdin (which has no echo to disable
 * anyway) cannot break it, and `stty echo` runs in a `finally`-equivalent so a
 * failed read never leaves the terminal mute.
 */
function promptHiddenPosix(question: string): Promise<string> {
  const script = [
    `printf '%s' "$1" >&2`,
    'stty -echo </dev/tty 2>/dev/null',
    'trap \'stty echo </dev/tty 2>/dev/null\' EXIT',
    'IFS= read -r value </dev/tty',
    'printf "%s" "$value"',
  ].join('\n');
  const child = spawn('sh', ['-c', script, 'sh', question], {
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  return new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      process.stderr.write('\n');
      if (code === 0) resolve(out);
      else reject(new Error(`could not read the password (sh exited ${code})`));
    });
  });
}

/** True when PowerShell is actually available (only used for a nicer error). */
function hasPowerShell(): boolean {
  if (process.platform !== 'win32') return false;
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], {
    stdio: 'ignore',
  });
  return probe.status === 0;
}
