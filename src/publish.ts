/**
 * Publishing and updating scripts.
 *
 * Verified against the live site and the upstream Rails app (2026-10):
 *
 *   - The form lives at `/<locale>/script_versions/new` (create) and
 *     `/<locale>/scripts/<id>/versions/new` (update).
 *   - It POSTs to `/<locale>/script_versions` / `/<locale>/scripts/<id>/versions`.
 *   - Success is a **302 to `/scripts/<id>-<slug>`**; a rejected submission is a
 *     **200 that re-renders the form**, so the status code alone cannot tell the
 *     two apart and the final URL is what decides.
 *   - Warnings ("version not incremented", "no namespace", …) are rendered as
 *     `script_version[…]` checkboxes the author is expected to confirm. They are
 *     not bypassed automatically: `--force` applies them, otherwise they are
 *     reported back.
 *
 * `POST /<locale>/script_versions/prefill` exists and needs only the session
 * cookie, but it renders the *same* form for a human to submit — so it is not a
 * publish path and is not used here.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import type { Client } from './client.js';
import type { HttpResponse } from './http.js';
import {
  buildPublishPayload,
  overridesFrom,
  type FormFields,
  type ScriptTypeName,
  type SyncTypeName,
} from './form.js';
import {
  findAuthenticityToken,
  findFlash,
  findFormContaining,
  findScriptName,
  findValidationErrors,
  looksLikeSignIn,
  pageSummary,
} from './htmlform.js';
import { compareVersions, metaAll, metaFirst, parseScriptId, parseSourceMeta, type UserscriptMeta } from './meta.js';

/** An error the caller should show as-is (already actionable). */
export class PublishError extends Error {
  constructor(
    message: string,
    /** Server-side validation messages, when the site rejected the submission. */
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export interface PublishOptions {
  /** Existing script id to update; omitted means "create a new script". */
  scriptId?: number;
  /** Only used when creating. */
  scriptType?: ScriptTypeName;
  /**
   * Source URL for code syncing. **Create-only**: the update route does not read
   * `import_url`, so a value passed with a `scriptId` is silently useless — the
   * CLI rejects that combination rather than pretending it worked.
   */
  syncUrl?: string;
  /** Defaults to `automatic` when a `syncUrl` is given. */
  syncType?: SyncTypeName;
  changelog?: string;
  additionalInfo?: string;
  /** Confirm pending warnings and submit again. */
  force?: boolean;
  /** Stop before the POST and report what would be sent. */
  dryRun?: boolean;
  onStep?: (line: string) => void;
}

export interface PublishResult {
  /** The script's name as the site now has it. */
  name: string;
  version: string;
  /** Absolute URL of the script's page. */
  url: string;
  /** The script id, parsed out of the redirect target. */
  scriptId?: number;
  /** True when this created a script rather than updating one. */
  created: boolean;
  /** Warning overrides that were confirmed on this attempt. */
  overrides: string[];
  dryRun?: boolean;
}

/** What the local file says, before anything is sent. */
export interface SourceInfo {
  name: string;
  version: string;
  kind: 'js' | 'css';
  /** `@include` + `@match` values. */
  targets: string[];
  meta: UserscriptMeta;
}

/**
 * Read and sanity-check a userscript.
 *
 * The site enforces these same rules server-side; checking locally turns a
 * round-trip and a wall of HTML into one clear line.
 */
export function inspectSource(path: string): { source: string; info: SourceInfo } {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (e) {
    throw new PublishError(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (source.length < 20) {
    throw new PublishError(`${path} is only ${source.length} bytes — the site rejects code under 20`);
  }

  const { meta, kind } = parseSourceMeta(source);
  if (meta.size === 0) {
    throw new PublishError(
      kind === 'css'
        ? `${path} has no /* ==UserStyle== … ==/UserStyle== */ block`
        : `${path} has no // ==UserScript== … // ==/UserScript== block`,
    );
  }

  const name = metaFirst(meta, 'name');
  const version = metaFirst(meta, 'version');
  const missing: string[] = [];
  if (!name) missing.push('@name');
  if (!version) missing.push('@version');
  if (missing.length > 0) {
    throw new PublishError(`${basename(path)} is missing ${missing.join(' and ')} in its meta block`);
  }
  if (version.length > 200) {
    throw new PublishError(`@version is ${version.length} characters; the site caps it at 200`);
  }

  const targets = [...metaAll(meta, 'match'), ...metaAll(meta, 'include')];
  if (kind === 'js' && targets.length === 0) {
    throw new PublishError(
      `${basename(path)} has no @match or @include — the site rejects a public script without one`,
    );
  }

  return { source, info: { name, version, kind, targets, meta } };
}

/**
 * Refuse an update that does not bump `@version`.
 *
 * Greasy Fork treats a re-submitted version as a warning the author can wave
 * through, but it also means userscript managers never see the update — so this
 * is almost always a mistake, and the fix (bump it) is one edit away.
 */
export function checkVersionBump(info: SourceInfo, publishedVersion: string | undefined): void {
  if (!publishedVersion) return;
  if (compareVersions(info.version, publishedVersion) > 0) return;
  throw new PublishError(
    `${info.name} is already at ${publishedVersion} on Greasy Fork, and the file still says ` +
      `${info.version} — bump @version before publishing (pass --force to submit anyway)`,
  );
}

function createUrl(client: Client): string {
  return `${client.mainSite}/${client.locale}/script_versions/new`;
}

function updateUrl(client: Client, id: number): string {
  return `${client.mainSite}/${client.locale}/scripts/${id}/versions/new`;
}

interface PublishForm {
  action: string;
  token: string;
  /** Present when the page is a rejection rather than a fresh form. */
  problems: string[];
  warnings: string[];
}

/**
 * Load a publish form and pull the token, the action and any refusal text out of it.
 *
 * The form carries no class or id, so it is located by the one thing that is
 * unique to it: a `script_version[code]` field inside it.
 */
async function loadForm(client: Client, url: string): Promise<PublishForm> {
  const res = await client.fetchHtml(url);
  if (looksLikeSignIn(res.body)) {
    throw new PublishError('not signed in (or the session expired) — run `gf login` first');
  }
  const form = findFormContaining(res.body, 'script_version[code]');
  if (!form) {
    // No form at all: the site renders its refusal states this way.
    const summary = pageSummary(res.body);
    throw new PublishError(
      summary
        ? `the site will not show the publish form: ${summary}`
        : `no publish form at ${url}`,
    );
  }
  return {
    action: form.action.startsWith('http') ? form.action : `${client.mainSite}${form.action}`,
    token: findAuthenticityToken(form.html),
    problems: findValidationErrors(res.body),
    warnings: overridesFrom(res.body),
  };
}

/** The script page a successful publish redirects to, or null. */
function scriptPageOf(finalUrl: string): { id?: number; url: string } | null {
  const m = /\/scripts\/(\d+)(?:-([^/?#]+))?/.exec(finalUrl);
  if (!m) return null;
  if (finalUrl.includes('/versions/')) return null;
  return { ...(m[1] ? { id: Number.parseInt(m[1], 10) } : {}), url: finalUrl };
}

/**
 * Publish (create or update) a userscript from a local file.
 *
 * `--force` is deliberately not the default: the warnings the site raises are the
 * author's own confirmations to make, and silently ticking them all would publish
 * a version that userscript managers will never pick up.
 */
export async function publish(
  client: Client,
  path: string,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const step = options.onStep ?? (() => {});
  const { source, info } = inspectSource(path);
  const forUpdate = options.scriptId !== undefined;

  if (forUpdate) {
    const published = await publishedVersion(client, options.scriptId!);
    if (!options.force) checkVersionBump(info, published);
  }

  const formUrl = forUpdate ? updateUrl(client, options.scriptId!) : createUrl(client);
  step(`GET ${formUrl}`);
  const form = await loadForm(client, formUrl);

  if (form.problems.length > 0) {
    throw new PublishError(
      `the site refused the ${forUpdate ? 'update form' : 'new script form'}`,
      form.problems,
    );
  }

  const overrides = options.force ? form.warnings : [];
  const payload = (token: string, confirmed: readonly string[]): FormFields =>
    buildPublishPayload({
      code: source,
      token,
      ...(forUpdate
        ? {}
        : {
            scriptType: options.scriptType ?? 'public',
            language: info.kind,
            // Syncing rides along with the other create-only fields because the
            // update route never reads `import_url`/`sync_type`. Set it at
            // creation or not at all — afterwards it is a browser-only setting.
            ...(options.syncUrl
              ? { syncUrl: options.syncUrl, syncType: options.syncType ?? 'automatic' }
              : {}),
          }),
      ...(options.changelog ? { changelog: options.changelog } : {}),
      ...(options.additionalInfo ? { additionalInfo: options.additionalInfo } : {}),
      overrides: confirmed,
    });

  if (options.dryRun) {
    step(`POST ${form.action} (dry run — nothing sent)`);
    return {
      name: info.name,
      version: info.version,
      url: '',
      created: !forUpdate,
      overrides,
      dryRun: true,
    };
  }

  step(`POST ${form.action}`);
  let res = await client.submitForm(form.action, payload(form.token, overrides), {
    referer: formUrl,
  });
  if (looksLikeSignIn(res.body)) {
    throw new PublishError('the session expired while publishing — run `gf login` again');
  }

  let applied = overrides;
  let site = scriptPageOf(res.finalUrl);

  // Rejected on the first try, with warnings still pending: confirm them once if
  // asked to. A second failure is reported rather than looped on.
  const pending = overridesFrom(res.body);
  if (!site && options.force && pending.length > applied.length) {
    applied = pending;
    step(`confirming ${pending.length} warning(s) and resubmitting`);
    const retryToken = findAuthenticityToken(res.body) || form.token;
    res = await client.submitForm(form.action, payload(retryToken, applied), { referer: formUrl });
    site = scriptPageOf(res.finalUrl);
  }

  if (!site) throw refusal(res, info.name);

  return {
    name: findScriptName(res.body) || info.name,
    version: info.version,
    url: site.url,
    ...(site.id !== undefined ? { scriptId: site.id } : {}),
    created: !forUpdate,
    overrides: applied,
  };
}

/**
 * `@version` is lifted into the payload by the server from the code's meta block,
 * so it is never sent as its own field — a rejected form comes back with that
 * field blank, and sending it would override what the file actually says.
 */

/**
 * Turn a rejected response into a readable error.
 *
 * Takes the whole response rather than just the body: a 5xx is a failure on the
 * site's side, and reporting it as "the form was re-rendered" sends the reader
 * hunting for a validation problem that does not exist. Measured: posting without
 * `script_version[attachments][]` answered **500 with an empty body**, which the
 * old signature reported as a re-rendered form.
 */
function refusal(res: HttpResponse, name: string): PublishError {
  const html = res.body;
  if (res.status >= 500) {
    return new PublishError(
      `${name} was not published — the site answered HTTP ${res.status} with an empty body. ` +
        'That is a Greasy Fork-side error, not a validation failure, so the request itself may ' +
        'be missing a field the server assumes is present; re-run with -v and check the payload.',
    );
  }
  const problems = findValidationErrors(html);
  const warnings = overridesFrom(html);
  const flash = findFlash(html);
  const summary = pageSummary(html);

  if (problems.length > 0) {
    return new PublishError(`the site rejected ${name}`, problems);
  }
  if (warnings.length > 0) {
    return new PublishError(
      `${name} was not published — the site wants these warnings confirmed. ` +
        'Review them on the site, or re-run with --force to confirm them all.',
      warnings.map((w) => `warning: ${w}`),
    );
  }
  if (flash.alert) return new PublishError(`${name} was not published: ${flash.alert}`);
  if (summary) return new PublishError(`${name} was not published: ${summary}`);
  return new PublishError(`${name} was not published (the site re-rendered the form)`);
}

/** The version the site currently has, or undefined when it has none. */
async function publishedVersion(client: Client, id: number): Promise<string | undefined> {
  try {
    const script = await client.script(id);
    return script.version || undefined;
  } catch {
    return undefined;
  }
}

/** `GF_SCRIPT_TYPE` is the escape hatch for a non-default type. */
export function scriptTypeFromEnv(): ScriptTypeName | undefined {
  const raw = (process.env.GF_SCRIPT_TYPE ?? '').trim().toLowerCase();
  if (raw === 'public' || raw === 'unlisted' || raw === 'library') return raw;
  return undefined;
}

/** A one-line description of a source file, for `--dry-run` and status output. */
export function describeSource(info: SourceInfo, path: string): string {
  const size = Buffer.byteLength(readFileSync(path), 'utf8');
  return `${info.name} ${info.version} (${info.kind}, ${size} bytes, ${info.targets.length} target(s))`;
}

/** True for a path that exists and is a regular file. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The Greasy Fork id a script's own meta points at.
 *
 * A script that was installed from the site carries `@downloadURL` (and often
 * `@updateURL`) with `update.greasyfork.org/scripts/<id>/…` in it, which is
 * exactly the id an update has to be posted to — so `gf publish foo.user.js`
 * updates the script rather than creating a duplicate of it.
 */
export function inferScriptId(info: SourceInfo): number | undefined {
  for (const key of ['downloadurl', 'updateurl', 'installurl']) {
    const value = metaFirst(info.meta, key);
    if (!value.includes('greasyfork.org')) continue;
    try {
      return parseScriptId(value);
    } catch {
      // A URL without a recognisable id is simply not a hint.
    }
  }
  return undefined;
}
