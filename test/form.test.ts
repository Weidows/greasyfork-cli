import { describe, expect, it } from 'vitest';

import {
  buildPublishPayload,
  encodeForm,
  overridesFrom,
  SCRIPT_TYPES,
} from '../src/form.js';

describe('encodeForm', () => {
  it('encodes spaces as +, like a browser form encoder', () => {
    expect(encodeForm([['a', 'hello world']])).toBe('a=hello+world');
  });

  it('percent-encodes the characters encodeURIComponent leaves alone but forms escape', () => {
    // These four are the classic mismatch: encodeURIComponent keeps them, a form
    // encoder does not, and Rails decodes the form convention.
    expect(encodeForm([['a', "!*'()"]])).toBe('a=%21%2A%27%28%29');
  });

  it('encodes brackets in nested names', () => {
    expect(encodeForm([['script_version[code]', 'x']])).toBe(
      'script_version%5Bcode%5D=x',
    );
  });

  it('preserves field order', () => {
    expect(encodeForm([['b', '1'], ['a', '2']])).toBe('b=1&a=2');
  });
});

describe('buildPublishPayload', () => {
  const code = '/** x */';

  it('always carries the CSRF token first', () => {
    const fields = buildPublishPayload({ code, token: 'T' });
    expect(fields[0]).toEqual(['authenticity_token', 'T']);
  });

  it('sends the code as script_version[code]', () => {
    const fields = buildPublishPayload({ code, token: 'T' });
    expect(fields).toContainEqual(['script_version[code]', code]);
  });

  it('sends no script or language fields for a plain update', () => {
    const names = buildPublishPayload({ code, token: 'T' }).map(([k]) => k);
    // Overriding these on an update would rename the script or flip its type.
    expect(names).not.toContain('script[script_type]');
    expect(names).not.toContain('language');
    expect(names).not.toContain('script[locale_id]');
  });

  it('sends the numeric script_type when creating', () => {
    const fields = buildPublishPayload({ code, token: 'T', scriptType: 'unlisted', language: 'js' });
    expect(fields).toContainEqual(['script[script_type]', String(SCRIPT_TYPES.unlisted)]);
    expect(fields).toContainEqual(['language', 'js']);
  });

  it('never sends a bare `name` field for a normal script', () => {
    // `params[:name]` is only read for libraries; sending it for a public script
    // is harmless server-side but signals a misunderstanding of the form.
    const names = buildPublishPayload({ code, token: 'T', scriptType: 'public' }).map(([k]) => k);
    expect(names).not.toContain('name');
  });

  it('includes the changelog and its markup only when given', () => {
    const without = buildPublishPayload({ code, token: 'T' }).map(([k]) => k);
    expect(without).not.toContain('script_version[changelog]');
    const fields = buildPublishPayload({ code, token: 'T', changelog: 'fix things' });
    expect(fields).toContainEqual(['script_version[changelog]', 'fix things']);
    expect(fields).toContainEqual(['script_version[changelog_markup]', 'markdown']);
  });

  it('marks the default additional info as default and gives it a locale', () => {
    const fields = buildPublishPayload({
      code,
      token: 'T',
      additionalInfo: 'hello',
      additionalInfoLocaleId: '33',
    });
    expect(fields).toContainEqual(['script_version[additional_info][0][attribute_default]', 'true']);
    expect(fields).toContainEqual(['script_version[additional_info][0][attribute_value]', 'hello']);
    expect(fields).toContainEqual(['script_version[additional_info][0][value_markup]', 'markdown']);
    expect(fields).toContainEqual(['script_version[additional_info][0][locale]', '33']);
  });

  it('never sends `preview` — that would save nothing', () => {
    const names = buildPublishPayload({
      code,
      token: 'T',
      scriptType: 'public',
      overrides: ['version_check_override'],
    }).map(([k]) => k);
    expect(names).not.toContain('preview');
  });

  it('sends each confirmed override as a script_version checkbox', () => {
    const fields = buildPublishPayload({
      code,
      token: 'T',
      overrides: ['version_check_override', 'add_missing_namespace'],
    });
    expect(fields).toContainEqual(['script_version[version_check_override]', 'true']);
    expect(fields).toContainEqual(['script_version[add_missing_namespace]', 'true']);
  });

  it('sends no overrides by default', () => {
    const names = buildPublishPayload({ code, token: 'T' }).map(([k]) => k);
    expect(names.some((n) => n.endsWith('_override]') || n.endsWith('_confirmation]'))).toBe(false);
  });
});

describe('overridesFrom', () => {
  it('finds the checkboxes the server rendered', () => {
    const html =
      '<input type="hidden" name="script_version[version_check_override]" value="0" />' +
      '<input type="checkbox" value="true" name="script_version[version_check_override]" />';
    expect(overridesFrom(html)).toEqual(['version_check_override']);
  });

  it('finds several, in a stable order', () => {
    const html =
      '<input name="script_version[minified_confirmation]" />' +
      '<input name="script_version[version_check_override]" />';
    expect(overridesFrom(html)).toEqual(['version_check_override', 'minified_confirmation']);
  });

  it('returns nothing for a plain form', () => {
    expect(overridesFrom('<input name="script_version[code]" />')).toEqual([]);
  });
});
