/**
 * A minimal HTTP/1.1 response parser.
 *
 * The transport does not use `https.request` or `https.Agent`: Bun ignores
 * `Agent#createConnection` entirely (measured: 0 invocations where Node makes 1),
 * so an agent-based proxy cannot work in a Bun-compiled binary. Talking HTTP/1.1
 * over a socket we opened ourselves behaves identically on Node and Bun.
 *
 * Everything here is pure — it takes bytes and returns bytes — so the whole thing
 * is unit-testable without a network.
 */

export interface ParsedHead {
  status: number;
  statusText: string;
  /** Header names lowercased; repeated headers are joined with ", ". */
  headers: Record<string, string>;
  /** Bytes already read past the header terminator. */
  rest: Buffer;
}

/** Parse a response head, or return null when the head is not complete yet. */
export function parseHead(buf: Buffer): ParsedHead | null {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;

  const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
  const statusLine = lines.shift() ?? '';
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(statusLine);
  if (!match) throw new Error(`malformed HTTP status line: ${JSON.stringify(statusLine)}`);

  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }

  return {
    status: Number(match[1]),
    statusText: match[2] ?? '',
    headers,
    rest: Buffer.from(buf.subarray(end + 4)),
  };
}

type Mode = 'length' | 'chunked' | 'close';

/**
 * Collects a response body incrementally.
 *
 * Handles the three things an HTTP/1.1 reply can do: a `Content-Length`, chunked
 * transfer coding, or a body delimited by connection close.
 */
export class BodyReader {
  private readonly mode: Mode;
  private readonly expectedLength: number;
  private out: Buffer[] = [];
  private received = 0;

  // chunked state
  private chunkRemaining = 0;
  private awaitingChunkSize = true;
  /** Explicitly typed: `Buffer.alloc` infers `Buffer<ArrayBuffer>`, which the
   *  incoming `Buffer` (ArrayBufferLike) argument cannot be assigned to. */
  private pending: Buffer = Buffer.alloc(0);
  private finished = false;

  constructor(head: ParsedHead) {
    const encoding = head.headers['transfer-encoding']?.toLowerCase() ?? '';
    const lengthHeader = head.headers['content-length'];

    if (encoding.includes('chunked')) {
      this.mode = 'chunked';
      this.expectedLength = 0;
    } else if (lengthHeader !== undefined && /^\d+$/.test(lengthHeader.trim())) {
      this.mode = 'length';
      this.expectedLength = Number(lengthHeader.trim());
    } else {
      this.mode = 'close';
      this.expectedLength = 0;
    }

    if (head.rest.length > 0) this.push(head.rest);
  }

  /** Feed newly arrived bytes. */
  push(chunk: Buffer): void {
    if (this.finished || chunk.length === 0) return;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    if (this.mode === 'length') {
      this.received += chunk.length;
      this.out.push(chunk);
      if (this.received >= this.expectedLength) this.finished = true;
      return;
    }
    if (this.mode === 'close') {
      this.out.push(chunk);
      return;
    }
    this.consumeChunks();
  }

  /** Signal that the peer closed the connection (only meaningful in close mode). */
  end(): void {
    if (this.mode === 'close') this.finished = true;
    else if (this.mode === 'chunked' && this.awaitingChunkSize) this.finished = true;
  }

  get done(): boolean {
    return this.finished;
  }

  /** The decoded body. In length mode it is truncated to the declared size. */
  body(): Buffer {
    const raw = this.out.length === 1 ? this.out[0]! : Buffer.concat(this.out);
    return this.mode === 'length' && raw.length > this.expectedLength
      ? raw.subarray(0, this.expectedLength)
      : raw;
  }

  private consumeChunks(): void {
    for (;;) {
      if (this.awaitingChunkSize) {
        const lineEnd = this.pending.indexOf('\r\n');
        if (lineEnd < 0) {
          if (this.pending.length > 8192) throw new Error('oversized chunk-size line');
          return;
        }
        // A chunk-size line may carry extensions after a ';'.
        const sizeText = this.pending.subarray(0, lineEnd).toString('latin1').split(';')[0]!;
        this.pending = this.pending.subarray(lineEnd + 2);
        if (!/^[0-9a-fA-F]+$/.test(sizeText.trim())) {
          throw new Error(`malformed chunk size: ${JSON.stringify(sizeText)}`);
        }
        const size = Number.parseInt(sizeText.trim(), 16);
        if (size === 0) {
          // Last chunk: skip the terminating CRLF (and any trailers).
          const trailersEnd = this.pending.indexOf('\r\n\r\n');
          if (trailersEnd >= 0) this.pending = this.pending.subarray(trailersEnd + 4);
          else if (this.pending.length >= 2) this.pending = this.pending.subarray(2);
          this.finished = true;
          return;
        }
        this.chunkRemaining = size;
        this.awaitingChunkSize = false;
        continue;
      }

      if (this.pending.length < this.chunkRemaining + 2) {
        // Take what we can, keep the rest for the next push.
        if (this.pending.length > this.chunkRemaining) {
          this.out.push(Buffer.from(this.pending.subarray(0, this.chunkRemaining)));
          this.pending = this.pending.subarray(this.chunkRemaining);
          this.chunkRemaining = 0;
        }
        return;
      }
      this.out.push(Buffer.from(this.pending.subarray(0, this.chunkRemaining)));
      this.pending = this.pending.subarray(this.chunkRemaining + 2); // skip CRLF
      this.chunkRemaining = 0;
      this.awaitingChunkSize = true;
    }
  }
}

/** Decode an entire (already complete) HTTP/1.1 response in one go. */
export function parseResponse(buf: Buffer): { head: ParsedHead; body: Buffer } {
  const head = parseHead(buf);
  if (!head) throw new Error('incomplete response head');
  const reader = new BodyReader(head);
  reader.end();
  return { head, body: reader.body() };
}
