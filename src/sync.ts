/**
 * Code syncing: let Greasy Fork pull a script's code from a URL (a Git repo, say)
 * instead of treating the uploaded body as the source of truth.
 *
 * Two very different call sites, and mixing them up is the classic mistake:
 *
 *  - **Creating** a script binds syncing through the *publish* form's top-level
 *    `import_url`/`sync_type` fields (`gf publish --sync-url`), and only on that
 *    path — the update route ignores both.
 *  - **Changing** syncing on an existing script goes through the script's own
 *    settings form (`gf sync`), which posts `script[sync_identifier]` and
 *    `script[sync_type]` plus whichever submit button was pressed. Different field
 *    names, different endpoint, different shape.
 */
import type { Client } from './client.js';
import { SYNC_TYPES, type FormFields, type SyncTypeName } from './form.js';
import { findAuthenticityToken, findFlash, findFormContaining, looksLikeSignIn } from './htmlform.js';

/** A sync failure with a message meant for the user. */
export class SyncError extends Error {
  constructor(
    message: string,
    /** Server-side validation messages, when the site rejected the submission. */
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/**
 * The three submit buttons on the sync form.
 *
 * Each is sent as a bare parameter name with no value, and `sync_update` branches
 * on them in this order: `stop-syncing` clears the bindings and returns early,
 * `update-and-sync` additionally runs the importer once, and `update-only` just
 * saves. Sending none of them still saves, but picking one explicitly is how a
 * browser expresses intent — so the CLI does too.
 */
export const SYNC_ACTIONS = {
  /** Save the settings; do not pull the code now. */
  save: 'update-only',
  /** Save the settings and pull the code immediately. */
  pull: 'update-and-sync',
  /** Clear the bindings — the script keeps its current code but stops syncing. */
  stop: 'stop-syncing',
} as const;

export type SyncAction = keyof typeof SYNC_ACTIONS;

/** What the script's syncing looks like right now. */
export interface SyncState {
  /** The URL Greasy Fork pulls from, '' when syncing is off. */
  url: string;
  /** The mode, '' when syncing is off. */
  type: SyncTypeName | '';
}

/** Accept `599220` or `599220-any-slug` and yield the numeric id. */
export function scriptIdOf(value: string): number {
  const digits = /^\s*(\d+)/.exec(value)?.[1];
  if (!digits) {
    throw new SyncError(
      `expected a script id like 123456 (or 123456-some-slug), got ${JSON.stringify(value)}`,
    );
  }
  return Number(digits);
}

/** A field as the sync form would submit it, in document order. */
interface BodyField {
  name: string;
  value: string;
  checked: boolean;
}

const unquote = (v: string | undefined): string =>
  v === undefined ? '' : v.replace(/^&quot;|&quot;$/g, '').replace(/^"|"$/g, '');

/**
 * Every field of a body, with radios kept honest.
 *
 * `findInputs` flattens radios and would happily send `sync_type=manual` *and*
 * `sync_type=automatic`; Rails resolves that to the last one, which may not be the
 * one the user asked for. Replaying the form properly means dropping unchecked
 * radios instead of relying on submit order.
 */
function findBodyFields(html: string): BodyField[] {
  const fields: BodyField[] = [];
  const re = /<input[^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tag = m[0];
    const type = (/\btype\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'file' || type === 'image') continue;
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!name) continue;
    const value = unquote(/\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]);
    const isCheckable = type === 'radio' || type === 'checkbox';
    // Read the real `checked` attribute rather than assuming: treating a whole radio
    // group as unchecked silently drops the form's own choice (see fillBody).
    fields.push({ name, value, checked: isCheckable ? /\bchecked\b/i.test(tag) : true });
  }
  return fields;
}

/** The `sync_identifier` value currently stored, '' when nothing is bound. */
function readSyncUrl(html: string): string {
  const re = /<input[^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (!/\bname\s*=\s*["']script\[sync_identifier\]["']/i.test(m[0])) continue;
    return unquote(/\bvalue\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1]);
  }
  return '';
}

/** The `sync_type` radio that is checked, '' when nothing is bound. */
function readSyncType(html: string): SyncTypeName | '' {
  const re = /<input[^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tag = m[0];
    if (!/\bname\s*=\s*["']script\[sync_type\]["']/i.test(tag)) continue;
    if (!/\bchecked\b/i.test(tag)) continue;
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    if (value in SYNC_TYPES) return value as SyncTypeName;
  }
  return '';
}

/**
 * The `sync_type` values this form actually offers.
 *
 * Not every member of the enum is always selectable: the settings form renders one
 * radio per allowed mode, and the live page offered only `manual` and `automatic`
 * even though the model's enum also has `webhook`. Selecting a value with no radio
 * would drop the field entirely and save nothing, so the caller checks against this
 * rather than against `SYNC_TYPES`.
 */
export function readAvailableSyncTypes(html: string): SyncTypeName[] {
  const out: SyncTypeName[] = [];
  const re = /<input[^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tag = m[0];
    if (!/\bname\s*=\s*["']script\[sync_type\]["']/i.test(tag)) continue;
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    if (value in SYNC_TYPES && !out.includes(value as SyncTypeName)) {
      out.push(value as SyncTypeName);
    }
  }
  return out;
}

/**
 * Rewrite the form body from field components instead of patching `findInputs`
 * output in place, which would have no reliable way to omit a tagged radio.
 */
function fillBody(fields: BodyField[], url: string, type: SyncTypeName | ''): FormFields {
  const body: FormFields = [];
  for (const f of fields) {
    // The localized additional-info group is left out on purpose.
    //
    // `sync_update` runs its reconcile loop whenever `params['additional_info_sync']`
    // is present, and an entry that arrives blank is read as "stop syncing this one" —
    // so replaying the form's empty slot can unbind an existing per-locale
    // additional-info sync. Omitting the key skips that block entirely, which is the
    // only true no-op.
    if (f.name.startsWith('additional_info_sync')) continue;
    if (f.name === 'script[sync_identifier]') body.push([f.name, url]);
    else if (f.name === 'script[sync_type]') {
      // Drop the radios we are not selecting, and take only the chosen one.
      if (f.value === type) body.push([f.name, f.value]);
    } else if (f.checked) body.push([f.name, f.value]);
  }
  return body;
}

/** What a script's settings form says about its syncing right now. */
export interface SyncFormState {
  state: SyncState;
  /** The modes the form offers — a subset of the enum; `webhook` is not always one. */
  availableTypes: SyncTypeName[];
}

/**
 * Read the current binding out of a settings form. Pure: takes HTML, not a client,
 * so the shapes that matter (a bound form, an unbound one, a webhook-less form) can
 * be pinned offline.
 */
export function parseSyncState(formHtml: string): SyncFormState {
  return {
    state: { url: readSyncUrl(formHtml), type: readSyncType(formHtml) },
    availableTypes: readAvailableSyncTypes(formHtml),
  };
}

/**
 * Replay a settings form for submission, substituting the sync target.
 *
 * Exported because the radio handling is the fiddly part: `findInputs` flattens
 * radios, so a naive replay sends `sync_type=manual` *and* `sync_type=automatic` and
 * leaves it to Rails' parameter merging to pick one. This keeps only the chosen one.
 */
export function buildSyncBody(formHtml: string, url: string, type: SyncTypeName | ''): FormFields {
  return fillBody(findBodyFields(formHtml), url, type);
}

/**
 * Read a script's current syncing without changing anything.
 *
 * `GET /scripts/:id/admin` is the author's own settings page — the route is part of
 * `resources :scripts`, not an admin namespace, and `sync_update` sits in
 * `MEMBER_AUTHOR_ACTIONS`, so the script's author can use both.
 */
export async function readSyncState(
  client: Client,
  id: number,
): Promise<{ state: SyncState; availableTypes: SyncTypeName[]; action: string }> {
  const res = await client.fetchHtml(`${client.mainSite}/${client.locale}/scripts/${id}/admin`);
  if (looksLikeSignIn(res.body)) {
    throw new SyncError('not signed in — run `gf login` first, or the session expired');
  }
  const form = findFormContaining(res.body, 'sync_identifier');
  if (!form) {
    throw new SyncError(
      `could not find the syncing settings on ${client.mainSite}/${client.locale}/scripts/${id}/admin ` +
        '— either the script does not exist, or it is not yours to edit',
    );
  }
  return { ...parseSyncState(form.html), action: form.action };
}

export interface SyncOptions {
  /** New sync target. Omit to leave the stored URL alone. */
  url?: string;
  /** Mode to store. Defaults to whatever the script already uses, else automatic. */
  type?: SyncTypeName;
  /** Which button to press. */
  action?: SyncAction;
  /** Read the form and report what would be sent, without posting. */
  dryRun?: boolean;
}

export interface SyncResult {
  action: SyncAction;
  /** Null when nothing is bound; a bare `--type` cannot invent a URL. */
  state: SyncState | null;
  /** Set when the request was not actually sent. */
  dryRun: boolean;
  /** The line the site flashed back, when it sent one. */
  notice: string;
  /** URLs reached during the redirect chain (followed to learn the flash). */
  redirects: number;
}

/**
 * Change a script's syncing. Requires a signed-in author.
 *
 * The form is replayed faithfully — including its hidden `_method` and CSRF token,
 * taken **from the form itself** (the token in `<meta>` differs and is rejected) —
 * because a hand-built field set is what produced a 500 on the publish path.
 * `additional_info_sync` is deliberately NOT sent: it is only touched by
 * `sync_update` when present, so omitting it leaves any per-locale additional-info
 * syncing exactly as it is.
 */
export async function syncScript(
  client: Client,
  id: number,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const { state } = await readSyncState(client, id);
  const actionKey: SyncAction = options.action ?? 'save';
  const button = SYNC_ACTIONS[actionKey];

  // `stop` clears everything, so it takes no values; the others need a URL, and
  // falling back to the stored one is what makes `--type` alone meaningful.
  let url = '';
  let syncType: SyncTypeName | '' = '';
  if (actionKey === 'stop') {
    if (options.url || options.type) {
      throw new SyncError('--stop turns syncing off, so it cannot be combined with --url or --type');
    }
  } else {
    url = options.url ?? state.url;
    if (!url) {
      throw new SyncError(
        `script ${id} has no sync URL, so one is required — pass --url <raw file url>`,
      );
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new SyncError(`--url must start with http:// or https://, got ${JSON.stringify(url)}`);
    }
    syncType = options.type ?? (state.type || 'automatic');
  }

  const summary: SyncState | null =
    actionKey === 'stop' ? null : { url, type: syncType as SyncTypeName };

  if (options.dryRun) {
    return { action: actionKey, state: summary, dryRun: true, notice: '', redirects: 0 };
  }

  // Re-read so the token and the field list come from the very same form HTML that
  // is about to be submitted; a token from a different render can be stale.
  const page = await client.fetchHtml(`${client.mainSite}/${client.locale}/scripts/${id}/admin`);
  const form = findFormContaining(page.body, 'sync_identifier');
  if (!form) {
    throw new SyncError(`the syncing form disappeared from ${client.mainSite}/scripts/${id}/admin`);
  }
  const token = findAuthenticityToken(form.html);
  if (!token) {
    throw new SyncError(
      'the syncing form carried no authenticity token — the session may have expired; run `gf login` again',
    );
  }

  // Refuse a mode the form cannot express: picking one with no radio would drop
  // `sync_type` from the body entirely and save the rest as if it had worked.
  const { availableTypes } = parseSyncState(form.html);
  if (syncType && availableTypes.length > 0 && !availableTypes.includes(syncType)) {
    throw new SyncError(
      `the site's form does not offer ${JSON.stringify(syncType)} for this script ` +
        `(available: ${availableTypes.join(', ')})`,
    );
  }

  const body = buildSyncBody(form.html, url, syncType);
  // Roll the chosen button back in, after the CSRF token so a stray echo of
  // `authenticity_token` cannot arrive last and take over.
  body.push([button, '']);

  const endpoint = form.action.startsWith('http')
    ? form.action
    : `${client.mainSite}${form.action}`;
  const res = await client.submitForm(endpoint, body, {
    referer: `${client.mainSite}/${client.locale}/scripts/${id}/admin`,
  });

  // `render :admin` on failure, `redirect_to @script` on success — so the final URL
  // is the reliable success signal, exactly as with publishing (a rejected write is
  // still HTTP 200).
  const landedOnAdmin = /\/admin(\/|$|\?)/.test(res.finalUrl);
  if (res.status >= 400 || landedOnAdmin) {
    throw new SyncError(
      `the site did not accept the change (ended up at ${res.finalUrl.replace(client.mainSite, '')})` +
        (res.status >= 400 ? ` with HTTP ${res.status}` : ''),
      [],
    );
  }

  const notice = findFlash(res.body).notice ?? '';
  return {
    action: actionKey,
    state: summary,
    dryRun: false,
    notice,
    redirects: res.redirects,
  };
}

/** Re-export so callers can label the modes without importing the form module. */
export { SYNC_TYPES };
