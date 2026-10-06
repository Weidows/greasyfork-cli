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

/** Percent-encode one field the way a browser's form encoder does. */
function encodePair(key: string, value: string): string {
  const enc = (s: string): string =>
    encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
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

  if (input.language) fields.push(['language', input.language]);
  if (input.scriptType) fields.push(['script[script_type]', String(SCRIPT_TYPES[input.scriptType])]);
  if (input.localeId) fields.push(['script[locale_id]', input.localeId]);
  if (input.adultContent) fields.push(['script[adult_content_self_report]', '1']);

  fields.push(['script_version[code]', input.code]);

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
