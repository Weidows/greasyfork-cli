import { describe, expect, it } from 'vitest';

import {
  decodeEntities,
  findAuthenticityToken,
  findFlash,
  findFormContaining,
  findFormHtml,
  findInputs,
  findScriptName,
  findSelects,
  findValidationErrors,
  hasOtpField,
  looksLikeSignIn,
  pageSummary,
  stripTags,
} from '../src/htmlform.js';

/** Trimmed from the live sign-in page: two forms, so two tokens. */
const SIGN_IN_PAGE = `<!DOCTYPE html>
<html><head><meta name="csrf-param" content="authenticity_token" />
<meta name="csrf-token" content="TOKEN_FROM_META" /></head>
<body>
<form class="language-selector" action="/users/sign_in">
  <input type="hidden" name="authenticity_token" value="LOCALE_FORM_TOKEN" />
</form>
<form class="new_user" id="new_user" action="/en/users/sign_in" method="post">
  <input type="hidden" name="authenticity_token" value="LOGIN_FORM_TOKEN" />
  <input autocomplete="email" type="email" name="user[email]" id="user_email" />
  <input type="password" name="user[password]" id="user_password" />
  <input name="user[remember_me]" type="hidden" value="0" />
  <input type="submit" name="commit" value="Log in" />
</form>
</body></html>`;

describe('decodeEntities', () => {
  it('decodes the five entities Rails escapes', () => {
    expect(decodeEntities('&lt;a&gt; &amp; &quot;b&quot; &#39;c&#39;')).toBe(`<a> & "b" 'c'`);
  });
});

describe('findAuthenticityToken', () => {
  it('prefers the csrf-token meta tag', () => {
    expect(findAuthenticityToken(SIGN_IN_PAGE)).toBe('TOKEN_FROM_META');
  });

  it('falls back to the first hidden input when there is no meta tag', () => {
    const html = '<form><input type="hidden" name="authenticity_token" value="ABC" /></form>';
    expect(findAuthenticityToken(html)).toBe('ABC');
  });

  it('returns "" when the page has no token', () => {
    expect(findAuthenticityToken('<p>hi</p>')).toBe('');
  });
});

describe('findFormHtml', () => {
  it('returns the inner HTML of the matching form only', () => {
    const form = findFormHtml(SIGN_IN_PAGE, (a) => (a.class ?? '').includes('new_user'))!;
    expect(form.action).toBe('/en/users/sign_in');
    expect(form.method).toBe('POST');
    // The token of the OTHER form must not leak in — using it would fail CSRF.
    expect(form.html).toContain('LOGIN_FORM_TOKEN');
    expect(form.html).not.toContain('LOCALE_FORM_TOKEN');
  });

  it('stops at the first closing tag, since forms cannot nest', () => {
    const html = '<form class="a"><input name="x" /></form><form class="a"><input name="y" /></form>';
    const form = findFormHtml(html, (a) => a.class === 'a')!;
    expect(form.html).toContain('name="x"');
    expect(form.html).not.toContain('name="y"');
  });

  it('defaults a missing method to GET', () => {
    expect(findFormHtml('<form action="/x"></form>', () => true)!.method).toBe('GET');
  });

  it('returns undefined when nothing matches', () => {
    expect(findFormHtml(SIGN_IN_PAGE, (a) => a.class === 'nope')).toBeUndefined();
  });
});

describe('findFormContaining', () => {
  const PUBLISH_PAGE = `<form action="/en/script_versions" method="post">
  <input type="hidden" name="authenticity_token" value="PUB_TOKEN" />
  <textarea name="script_version[code]">x</textarea>
</form>`;

  it('locates the publish form by a field inside it', () => {
    const form = findFormContaining(PUBLISH_PAGE, 'script_version[code]')!;
    expect(form.action).toBe('/en/script_versions');
    expect(findAuthenticityToken(form.html)).toBe('PUB_TOKEN');
  });

  it('returns undefined when no form contains the marker', () => {
    expect(findFormContaining(SIGN_IN_PAGE, 'script_version[code]')).toBeUndefined();
  });
});

describe('findInputs / findSelects', () => {
  it('lists every named input with its value', () => {
    const inputs = findInputs(SIGN_IN_PAGE);
    expect(inputs).toContainEqual({ name: 'user[email]', value: '' });
    expect(inputs).toContainEqual({ name: 'user[remember_me]', value: '0' });
    expect(inputs).toContainEqual({ name: 'commit', value: 'Log in' });
  });

  it('lists a select with its options and the selected one', () => {
    const html =
      '<select name="script[locale_id]"><option value="" selected>Auto</option>' +
      '<option value="33">English</option></select>';
    expect(findSelects(html)).toEqual([
      { name: 'script[locale_id]', values: ['', '33'], selected: '' },
    ]);
  });
});

describe('looksLikeSignIn / hasOtpField', () => {
  it('recognises the sign-in form', () => {
    expect(looksLikeSignIn(SIGN_IN_PAGE)).toBe(true);
  });

  it('does not mistake another form for it', () => {
    expect(looksLikeSignIn('<form class="new_user"><input name="user[name]" /></form>')).toBe(false);
    expect(looksLikeSignIn('<form class="other"><input name="user[password]" /></form>')).toBe(false);
  });

  it('detects the 2FA step', () => {
    expect(hasOtpField('<input name="user[otp_attempt]" />')).toBe(true);
    expect(hasOtpField(SIGN_IN_PAGE)).toBe(false);
  });
});

describe('findFlash', () => {
  it('reads the notice and alert paragraphs', () => {
    const html = '<p class="notice">Signed in</p><p class="alert">Bad password</p>';
    expect(findFlash(html)).toEqual({ notice: 'Signed in', alert: 'Bad password' });
  });

  it('returns an empty object when there is no flash', () => {
    expect(findFlash('<p>plain</p>')).toEqual({});
  });
});

describe('findValidationErrors', () => {
  it('collects one message per paragraph', () => {
    const html =
      '<div class="validation-errors"><p>There were errors:</p>' +
      '<p>Code is invalid</p></div>';
    expect(findValidationErrors(html)).toEqual(['There were errors:', 'Code is invalid']);
  });

  it('returns nothing when the block is absent', () => {
    expect(findValidationErrors('<p>ok</p>')).toEqual([]);
  });
});

describe('pageSummary', () => {
  it('reads the paragraphs of a refusal page that has no form', () => {
    const html = '<div id="main"><div><p>You are rate limited. Try later.</p></div></div>';
    expect(pageSummary(html)).toBe('You are rate limited. Try later.');
  });
});

describe('findScriptName / stripTags', () => {
  it('reads the page heading', () => {
    expect(findScriptName('<h1>My Script</h1>')).toBe('My Script');
  });

  it('collapses whitespace and drops script bodies', () => {
    expect(stripTags('<p>a\n  b</p><script>var x = 1;</script>')).toBe('a b');
  });
});
