/**
 * Form payload building for the write paths.
 *
 * Greasy Fork's publish form is `enctype="multipart/form-data"`, but nothing is
 * actually uploaded when the code goes in the textarea, and Rack parses
 * `application/x-www-form-urlencoded` for a multipart-declared form just as well
 * — so this stays urlencoded and avoids hand-writing a multipart encoder.
 *
 * All pure, so the payload is unit tested offline in test/form.test.ts.
 */

/** One form field: a name and the value Rails expects. */
export type FormFields = Array<[string, string]>;

/**
 * Percent-encode one string the way a form/cookie encoder does.
 *
 * `encodeURIComponent` leaves `!*'()` alone; Rails (via `Rack::Utils.escape`)
 * escapes them. Sharing this between form pairs and the session-cookie value
 * keeps one definition of "correctly escaped" in the project.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Percent-encode one field the way a browser's form encoder does. */
function encodePair(key: string, value: string): string {
  const enc = (s: string): string => percentEncode(s).replace(/%20/g, '+');
  return `${enc(key)}=${enc(value)}`;
}

/** Serialise fields to an urlencoded request body. Order is preserved. */
export function encodeForm(fields: FormFields): string {
  return fields.map(([k, v]) => encodePair(k, v)).join('&');
}

/** Greasy Fork's `Script.script_type` enum values. */
export const SCRIPT_TYPES = {
  public: 1,
  unlisted: 2,
  library: 3,
} as const;

export type ScriptTypeName = keyof typeof SCRIPT_TYPES;

/**
 * Greasy Fork's `Script.sync_type` enum — how often the site re-pulls the code
 * from the script's `sync_identifier` URL.
 *
 * Sent by **name**, not by id: the controller's own fallback is the string
 * `params['sync_type'] || 'manual'`, and a Rails enum setter takes a name. The
 * numbers are recorded only to document the order in the model.
 */
export const SYNC_TYPES = {
  manual: 1,
  automatic: 2,
  webhook: 3,
} as const;

export type SyncTypeName = keyof typeof SYNC_TYPES;

export const SYNC_TYPE_NAMES = Object.keys(SYNC_TYPES) as SyncTypeName[];

/**
 * Every `script_version[…]` checkbox the server offers as a "do you really mean
 * it" gate. Each is rendered only when the corresponding warning fires, so the
 * publish flow reads the flags out of the rejected response rather than guessing.
 */
export const WARNING_OVERRIDES = [
  'version_check_override',
  'add_missing_version',
  'add_missing_namespace',
  'namespace_check_override',
  'minified_confirmation',
  'sensitive_site_confirmation',
  'allow_code_previously_posted',
  'license_missing_override',
  'meta_not_at_start_confirmation',
] as const;

export interface PublishPayloadInput {
  code: string;
  token: string;
  /** Omitted means "let the site decide" (the form's default option). */
  scriptType?: ScriptTypeName;
  /** `language` is only sent when creating; the site takes it from the script otherwise. */
  language?: 'js' | 'css';
  /** Only meaningful when updating an existing script. */
  changelog?: string;
  /** How the changelog text should be parsed. */
  changelogMarkup?: 'markdown' | 'html';
  additionalInfo?: string;
  additionalInfoLocaleId?: string;
  additionalInfoMarkup?: 'markdown' | 'html';
  /** Numeric Greasy Fork locale id; omitted means auto-detect. */
  localeId?: string;
  adultContent?: boolean;
  /**
   * Code syncing — **create only**.
   *
   * With a `syncUrl`, Greasy Fork stops treating the posted body as the source of
   * truth and pulls the code from that URL instead, on the `syncType` schedule.
   * The update route does not read either field, so this has to be set when the
   * script is first created; afterwards it is a browser-only setting.
   */
  syncUrl?: string;
  syncType?: SyncTypeName;
  /** Warning overrides to force on this attempt. */
  overrides?: readonly string[];
}

/**
 * Build the POST body for `POST /<locale>/script_versions` (new) or
 * `POST /<locale>/scripts/<id>/versions` (update). One builder for both: the
 * server reads the same parameter names on either route.
 */
export function buildPublishPayload(input: PublishPayloadInput): FormFields {
  const fields: FormFields = [['authenticity_token', input.token]];

  // Top-level, NOT `script_version[…]`: the controller reads `params[:import_url]`
  // and `params[:sync_type]` directly, and only on the create path. `sync_type`
  // is ignored without `import_url` (both are read inside the same `if`), so it
  // is never sent alone.
  if (input.syncUrl) {
    fields.push(['import_url', input.syncUrl]);
    fields.push(['sync_type', input.syncType ?? 'automatic']);
  }

  if (input.language) fields.push(['language', input.language]);
  if (input.scriptType) fields.push(['script[script_type]', String(SCRIPT_TYPES[input.scriptType])]);
  if (input.localeId) fields.push(['script[locale_id]', input.localeId]);
  if (input.adultContent) fields.push(['script[adult_content_self_report]', '1']);

  fields.push(['script_version[code]', input.code]);

  // Required, even though the value is empty.
  //
  // `create` runs `svp['attachments'].reject { … }` unconditionally, and
  // ActionController's `expect(script_version: [ … { attachments: [] } ])` yields
  // **nil**, not `[]`, when the key is absent — so a POST without this field dies
  // as a 500 with an empty body, not as a validation error. A browser never hits
  // it because a `multiple` file input submits an empty entry even when no file is
  // chosen; only a hand-built payload can omit it. Measured: adding this empty
  // field turned a 500 into an ordinary validation response.
  fields.push(['script_version[attachments][]', '']);

  if (input.changelog) {
    fields.push(['script_version[changelog]', input.changelog]);
    fields.push(['script_version[changelog_markup]', input.changelogMarkup ?? 'markdown']);
  }

  if (input.additionalInfo) {
    const markup = input.additionalInfoMarkup ?? 'markdown';
    fields.push(['script_version[additional_info][0][attribute_default]', 'true']);
    fields.push(['script_version[additional_info][0][attribute_value]', input.additionalInfo]);
    fields.push(['script_version[additional_info][0][value_markup]', markup]);
    if (input.additionalInfoLocaleId) {
      fields.push(['script_version[additional_info][0][locale]', input.additionalInfoLocaleId]);
    }
  }

  for (const override of input.overrides ?? []) {
    fields.push([`script_version[${override}]`, 'true']);
  }

  return fields;
}

/** Which warning overrides a rejected publish response is asking for. */
export function overridesFrom(html: string): string[] {
  const found: string[] = [];
  for (const name of WARNING_OVERRIDES) {
    // The checkbox ships with `name="script_version[<flag>]"`; an unchecked
    // Rails checkbox still emits a hidden `<input value="0">`, so the presence
    // of the name is what matters, not its value.
    const re = new RegExp(`name=["']script_version\\[${name}\\]["']`, 'i');
    if (re.test(html)) found.push(name);
  }
  return found;
}
