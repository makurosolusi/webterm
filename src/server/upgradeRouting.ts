import { LSP_WS_PATH } from './lsp/lsp.contract'

/** Decide what to do with an upgrade: in dev Vite shares this server and owns its HMR upgrades, so non-ws ones must be left alone.
 *  `browserPath` diisi HANYA bila runtime browser aktif; absen = jalur itu diperlakukan seperti path asing (perilaku lama).
 *  `/ws/lsp` (editor language servers) is always ours. */
export function upgradeRoute(pathname: string, wsPath: string, dev: boolean, browserPath?: string): 'ws' | 'browser' | 'lsp' | 'destroy' | 'ignore' {
  if (pathname === wsPath) return 'ws'
  if (browserPath !== undefined && pathname === browserPath) return 'browser'
  if (pathname === LSP_WS_PATH) return 'lsp'
  return dev ? 'ignore' : 'destroy'
}
