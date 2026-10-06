import { describe, expect, it } from 'vitest';

import { BodyReader, parseHead, parseResponse } from '../src/http1.js';

const crlf = (s: string): Buffer => Buffer.from(s, 'latin1');

describe('parseHead', () => {
  it('returns null until the terminator arrives', () => {
    expect(parseHead(crlf('HTTP/1.1 200 OK\r\nContent-Length: 2'))).toBeNull();
    expect(parseHead(crlf('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n'))).not.toBeNull();
  });

  it('lowercases header names and keeps repeated ones', () => {
    const head = parseHead(
      crlf('HTTP/1.1 308 Permanent Redirect\r\nLocation: https://a/b\r\nSet-Cookie: x=1\r\nSet-Cookie: y=2\r\n\r\n'),
    )!;
    expect(head.status).toBe(308);
    expect(head.statusText).toBe('Permanent Redirect');
    expect(head.headers.location).toBe('https://a/b');
    // Repeated headers are joined with ", " — EXCEPT set-cookie, which is kept as
    // one entry per line. Joining them cannot be undone, because a cookie's
    // `Expires` attribute itself contains a comma.
    expect(head.headers['set-cookie']).toBeUndefined();
    expect(head.setCookie).toEqual(['x=1', 'y=2']);
  });

  it('keeps a Set-Cookie whose Expires contains a comma intact', () => {
    const head = parseHead(
      crlf(
        'HTTP/1.1 200 OK\r\n' +
          'Set-Cookie: _greasyfork_session=abc; path=/; expires=Wed, 21 Oct 2026 07:28:00 GMT; secure; httponly\r\n' +
          '\r\n',
      ),
    )!;
    expect(head.setCookie).toHaveLength(1);
    expect(head.setCookie[0]).toContain('_greasyfork_session=abc');
    expect(head.setCookie[0]).toContain('expires=Wed, 21 Oct 2026 07:28:00 GMT');
  });

  it('exposes bytes that arrived with the head', () => {
    const head = parseHead(crlf('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc'))!;
    expect(head.rest.toString()).toBe('abc');
  });

  it('rejects a malformed status line', () => {
    expect(() => parseHead(crlf('nonsense\r\n\r\n'))).toThrow(/malformed HTTP status line/);
  });
});

describe('BodyReader: content-length', () => {
  it('finishes as soon as the declared length arrives', () => {
    const head = parseHead(crlf('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n'))!;
    const reader = new BodyReader(head);
    expect(reader.done).toBe(false);
    reader.push(Buffer.from('hello'));
    expect(reader.done).toBe(true);
    expect(reader.body().toString()).toBe('hello');
  });

  it('truncates a body longer than the declared length', () => {
    const { body } = parseResponse(
      crlf('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdefg'),
    );
    expect(body.toString()).toBe('abc');
  });

  it('handles the body being split across many pushes', () => {
    const head = parseHead(crlf('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n'))!;
    const reader = new BodyReader(head);
    for (const ch of 'hello world') {
      expect(reader.done).toBe(false);
      reader.push(Buffer.from(ch));
    }
    expect(reader.done).toBe(true);
    expect(reader.body().toString()).toBe('hello world');
  });

  it('counts bytes that came in with the head', () => {
    const head = parseHead(crlf('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel'))!;
    const reader = new BodyReader(head);
    expect(reader.done).toBe(false);
    reader.push(Buffer.from('lo'));
    expect(reader.done).toBe(true);
    expect(reader.body().toString()).toBe('hello');
  });
});

describe('BodyReader: chunked', () => {
  it('decodes a simple chunked body', () => {
    const { body } = parseResponse(
      crlf('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n'),
    );
    expect(body.toString()).toBe('hello world');
  });

  it('decodes when chunk boundaries land mid-push', () => {
    const wire = crlf('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n') as Buffer;
    const head = parseHead(wire)!;
    const reader = new BodyReader(head);
    const payload = crlf('4\r\nabcd\r\n3\r\nefg\r\n0\r\n\r\n');
    // one byte at a time: exercises the incremental chunk state machine
    for (const byte of payload) reader.push(Buffer.from([byte]));
    expect(reader.done).toBe(true);
    expect(reader.body().toString()).toBe('abcdefg');
  });

  it('tolerates chunk extensions and trailers', () => {
    const { body } = parseResponse(
      crlf(
        'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
          '3;foo=bar\r\nabc\r\n0\r\nX-Trailer: 1\r\n\r\n',
      ),
    );
    expect(body.toString()).toBe('abc');
  });

  it('throws on a malformed chunk size', () => {
    const head = parseHead(crlf('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'))!;
    const reader = new BodyReader(head);
    expect(() => reader.push(crlf('zz\r\nabc\r\n'))).toThrow(/malformed chunk size/);
  });

  it('detects chunked case-insensitively', () => {
    const { body } = parseResponse(
      crlf('HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n'),
    );
    expect(body.toString()).toBe('x');
  });
});

describe('BodyReader: close-delimited', () => {
  it('collects until the peer closes', () => {
    const head = parseHead(crlf('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n'))!;
    const reader = new BodyReader(head);
    reader.push(Buffer.from('no length '));
    reader.push(Buffer.from('header here'));
    expect(reader.done).toBe(false);
    reader.end();
    expect(reader.done).toBe(true);
    expect(reader.body().toString()).toBe('no length header here');
  });
});

describe('parseResponse', () => {
  it('is not confused by a header whose value contains a colon', () => {
    const { head, body } = parseResponse(
      crlf('HTTP/1.1 200 OK\r\nLocation: https://example.com:8443/x\r\nContent-Length: 2\r\n\r\n{}'),
    );
    expect(head.headers.location).toBe('https://example.com:8443/x');
    expect(body.toString()).toBe('{}');
  });
});
