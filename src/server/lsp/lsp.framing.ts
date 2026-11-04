// LSP base protocol over stdio: `Content-Length: <bytes>\r\n\r\n<json>` (LSP spec "Base Protocol").
// Length counts BYTES, so the buffer is kept as bytes and only a complete body is decoded.

/** Frame one JSON-RPC message (already serialized) for a language server's stdin. */
export function frameLsp(json: string): string {
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`
}

const SEP = Buffer.from('\r\n\r\n')

/** Incremental decoder for a language server's stdout: feed chunks, get whole message bodies back. */
export class LspFramer {
  private buf = Buffer.alloc(0)

  feed(chunk: Buffer | string): string[] {
    this.buf = Buffer.concat([this.buf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
    const out: string[] = []
    for (;;) {
      const end = this.buf.indexOf(SEP)
      if (end < 0) return out
      const m = /content-length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString('ascii'))
      if (!m) {
        // Header without a length cannot be framed; drop it so one bad header cannot wedge the stream.
        this.buf = this.buf.subarray(end + SEP.length)
        continue
      }
      const start = end + SEP.length
      const len = Number(m[1])
      if (this.buf.length < start + len) return out
      out.push(this.buf.subarray(start, start + len).toString('utf8'))
      this.buf = this.buf.subarray(start + len)
    }
  }
}
