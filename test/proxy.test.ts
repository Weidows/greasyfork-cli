import { describe, expect, it } from 'vitest';

import { detectProxy, parseProxyUrl, resolveProxy } from '../src/proxy.js';

describe('detectProxy', () => {
  it('reads the usual environment variables, greasyfork-cli first', () => {
    expect(detectProxy({ GREASYFORK_CLI_PROXY: 'http://a:1' } as NodeJS.ProcessEnv)).toBe('http://a:1');
    expect(detectProxy({ https_proxy: 'http://a:1' } as NodeJS.ProcessEnv)).toBe('http://a:1');
    expect(detectProxy({ HTTPS_PROXY: 'http://b:2' } as NodeJS.ProcessEnv)).toBe('http://b:2');
    expect(detectProxy({ http_proxy: 'http://c:3' } as NodeJS.ProcessEnv)).toBe('http://c:3');
  });

  it('prefers the explicit variable and ignores blank values', () => {
    expect(
      detectProxy({ GREASYFORK_CLI_PROXY: 'http://win:1', https_proxy: 'http://lose:2' } as NodeJS.ProcessEnv),
    ).toBe('http://win:1');
    expect(detectProxy({ https_proxy: '   ' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('returns undefined when nothing is configured', () => {
    expect(detectProxy({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('parseProxyUrl', () => {
  it('defaults the scheme to http://', () => {
    expect(parseProxyUrl('127.0.0.1:7890').protocol).toBe('http:');
    expect(parseProxyUrl('127.0.0.1:7890').hostname).toBe('127.0.0.1');
    expect(parseProxyUrl('http://127.0.0.1:7890').port).toBe('7890');
  });

  it('rejects schemes it cannot tunnel with', () => {
    expect(() => parseProxyUrl('socks5://127.0.0.1:1080')).toThrow(/unsupported proxy scheme/);
  });
});

describe('resolveProxy', () => {
  it('returns an explicit proxy untouched, without touching git', async () => {
    await expect(resolveProxy('http://explicit:1234')).resolves.toBe('http://explicit:1234');
  });
});
