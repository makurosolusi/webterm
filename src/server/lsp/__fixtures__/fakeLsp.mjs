// test-only: minimal stdio JSON-RPC language server for lsp.manager / lsp.route tests.
// initialize -> {capabilities, serverInfo:{version: pid}}; test/echo -> params; test/opened -> open uris;
// didOpen -> publishDiagnostics; test/ask -> sends a server->client request; test/die -> exit 3.
const open = new Set()
let buf = Buffer.alloc(0)
const send = (m) => {
  const j = JSON.stringify({ jsonrpc: '2.0', ...m })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`)
}
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c])
  for (;;) {
    const end = buf.indexOf('\r\n\r\n')
    if (end < 0) return
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())[1])
    if (buf.length < end + 4 + len) return
    const m = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString())
    buf = buf.subarray(end + 4 + len)
    const uri = m.params?.textDocument?.uri
    if (m.method === 'initialize') send({ id: m.id, result: { rootUri: m.params?.rootUri, capabilities: { hoverProvider: true }, serverInfo: { name: 'fake', version: String(process.pid) } } })
    else if (m.method === 'test/echo') send({ id: m.id, result: m.params })
    else if (m.method === 'test/opened') send({ id: m.id, result: [...open] })
    else if (m.method === 'test/ask') send({ id: 'srv-1', method: 'workspace/configuration', params: { items: [{}] } })
    else if (m.method === 'test/die') process.exit(3)
    else if (m.method === 'textDocument/didOpen') {
      open.add(uri)
      send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'fake', severity: 1 }] } })
    } else if (m.method === 'textDocument/didClose') open.delete(uri)
  }
})
