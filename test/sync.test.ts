import { describe, expect, it } from 'vitest';

import { buildSyncBody, parseSyncState, scriptIdOf, SYNC_ACTIONS, SyncError } from '../src/sync.js';

/**
 * Trimmed from the live settings form, but with invented ids and URLs: this repo is
 * public, so no real account, script id or repository may appear in a fixture.
 *
 * Note `value` precedes `name` on the sync_identifier input, matching the real page:
 * an earlier probe regex assumed `name` came first and silently read an empty value,
 * which is exactly the kind of order-dependence this fixture should keep catching.
 */
const SYNC_FORM = `
<form action="/en/scripts/123456/sync_update" method="post">
  <input type="hidden" name="_method" value="patch" />
  <input type="hidden" name="authenticity_token" value="FORM_TOKEN" />
  <input placeholder="(link)" type="url" value="https://raw.githubusercontent.com/someone/repo/main/a.user.js" name="script[sync_identifier]" />
  <input type="radio" name="script[sync_type]" value="automatic" checked />
  <input type="radio" name="script[sync_type]" value="manual" />
  <input type="hidden" name="additional_info_sync[0][attribute_default]" value="true" />
  <input type="url" name="additional_info_sync[0][sync_identifier]" value="" />
  <input type="radio" name="additional_info_sync[0][value_markup]" value="html" checked />
  <input type="radio" name="additional_info_sync[0][value_markup]" value="markdown" />
  <input type="submit" name="update-only" value="Update" />
  <input type="submit" name="update-and-sync" value="Update and sync now" />
  <input type="submit" name="stop-syncing" value="Stop syncing" />
</form>`;

/** The same form for a script that has never been bound to a source. */
const UNBOUND_FORM = `
<form action="/en/scripts/123456/sync_update" method="post">
  <input type="hidden" name="_method" value="patch" />
  <input type="hidden" name="authenticity_token" value="FORM_TOKEN" />
  <input type="url" name="script[sync_identifier]" value="" />
  <input type="radio" name="script[sync_type]" value="automatic" />
  <input type="radio" name="script[sync_type]" value="manual" checked />
</form>`;

describe('parseSyncState', () => {
  it('reads the bound URL and the checked mode', () => {
    const { state } = parseSyncState(SYNC_FORM);
    expect(state.url).toBe('https://raw.githubusercontent.com/someone/repo/main/a.user.js');
    expect(state.type).toBe('automatic');
  });

  it('does not depend on attribute order on the input tag', () => {
    // The real page writes `placeholder`, `type`, `value`, `name` — value before
    // name. A parser that regexes name-then-value reads an empty string and looks
    // like "no sync bound", which would silently disable the feature's own check.
    const reordered = `<input value="https://x/y.js" name="script[sync_identifier]" />`;
    expect(parseSyncState(reordered).state.url).toBe('https://x/y.js');
  });

  it('reports the modes the form actually offers', () => {
    // Only the two radios present are offered. The model's enum also has `webhook`,
    // but a value with no radio would drop out of the body entirely on submit, so
    // the caller must validate against this list rather than against the enum.
    expect(parseSyncState(SYNC_FORM).availableTypes).toEqual(['automatic', 'manual']);
  });

  it('reports an unbound script as empty, not as "manual"', () => {
    const { state, availableTypes } = parseSyncState(UNBOUND_FORM);
    expect(state.url).toBe('');
    expect(state.type).toBe('manual');
    expect(availableTypes).toEqual(['automatic', 'manual']);
  });
});

describe('buildSyncBody', () => {
  it('substitutes the URL and keeps the form plumbing', () => {
    const body = buildSyncBody(SYNC_FORM, 'https://example.com/new.user.js', 'automatic');
    expect(body).toContainEqual(['script[sync_identifier]', 'https://example.com/new.user.js']);
    // The Rails method override and the FORM's token (the meta token is rejected).
    expect(body).toContainEqual(['_method', 'patch']);
    expect(body).toContainEqual(['authenticity_token', 'FORM_TOKEN']);
  });

  it('sends exactly one sync_type — the chosen radio, not both', () => {
    // `findInputs` flattens radios; a naive replay sends manual AND automatic and
    // leaves Rails' parameter merge to decide. That is how a script silently flips
    // to the other mode.
    const body = buildSyncBody(SYNC_FORM, 'https://x/y.js', 'manual');
    const types = body.filter(([k]) => k === 'script[sync_type]').map(([, v]) => v);
    expect(types).toEqual(['manual']);
  });

  it('sends no sync_type at all when nothing is chosen', () => {
    const body = buildSyncBody(SYNC_FORM, 'https://x/y.js', '');
    expect(body.some(([k]) => k === 'script[sync_type]')).toBe(false);
  });

  it('omits the additional-info sync group entirely', () => {
    // Deliberate, and not cosmetic. `sync_update` reconciles `additional_info_sync`
    // whenever the key is present, and an entry submitted blank counts as "stop
    // syncing this one" — so replaying the form's empty slot can unbind an existing
    // per-locale additional-info sync. Sending no key skips the block: the real no-op.
    const body = buildSyncBody(SYNC_FORM, 'https://x/y.js', 'automatic');
    expect(body.some(([k]) => k.startsWith('additional_info_sync'))).toBe(false);
  });

  it('keeps only the checked option of a radio group it does not own', () => {
    // Radios the CLI is not changing must be replayed as the form had them; marking
    // the whole group unchecked would drop the site's own choice from the body.
    const html =
      '<input type="radio" name="other" value="a" checked />' +
      '<input type="radio" name="other" value="b" />';
    expect(buildSyncBody(html, 'https://x/y.js', '')).toEqual([['other', 'a']]);
  });

  it('never sends a submit button — the caller adds the one it means', () => {
    const body = buildSyncBody(SYNC_FORM, 'https://x/y.js', 'automatic');
    for (const name of Object.values(SYNC_ACTIONS)) {
      expect(body.some(([k]) => k === name)).toBe(false);
    }
  });
});

describe('scriptIdOf', () => {
  it('parses a bare id and an id with a slug', () => {
    expect(scriptIdOf('123456')).toBe(123456);
    expect(scriptIdOf('123456-some-script-slug')).toBe(123456);
    expect(scriptIdOf('  123456 ')).toBe(123456);
  });

  it('rejects anything without a leading number', () => {
    // A slug-only path (`/users/<name>`) parses as NaN in a naive implementation and
    // would address script "NaN" instead of failing loudly.
    expect(() => scriptIdOf('some-slug')).toThrow(SyncError);
    expect(() => scriptIdOf('')).toThrow(SyncError);
  });
});

describe('SYNC_ACTIONS', () => {
  it('maps to the submit button names the controller branches on', () => {
    // `sync_update` checks `stop-syncing` first and returns early, then
    // `update-and-sync` to pull immediately; `update-only` just saves.
    expect(SYNC_ACTIONS.stop).toBe('stop-syncing');
    expect(SYNC_ACTIONS.pull).toBe('update-and-sync');
    expect(SYNC_ACTIONS.save).toBe('update-only');
  });
});
