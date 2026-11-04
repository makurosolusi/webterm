// Wire constants of the editor LSP channel, dependency-free so routing and the client (by copy, see
// src/client/editorLsp.client.ts) can share them.

export const LSP_WS_PATH = '/ws/lsp'
/** First (and only) frame when no server exists; then the socket closes with LSP_CLOSE.unavailable. */
export const LSP_UNAVAILABLE = 'lsp-unavailable'
/** Close codes the client reads (4000-4999 = application range, RFC 6455 §7.4.2). */
export const LSP_CLOSE = { replaced: 4000, unavailable: 4404, exited: 4500 } as const
