/** Decide what to do with an upgrade: in dev Vite shares this server and owns its HMR upgrades, so non-ws ones must be left alone.
 *  `browserPath` diisi HANYA bila runtime browser aktif; absen = jalur itu diperlakukan seperti path asing (perilaku lama). */
export function upgradeRoute(pathname: string, wsPath: string, dev: boolean, browserPath?: string): 'ws' | 'browser' | 'destroy' | 'ignore' {
  if (pathname === wsPath) return 'ws'
  if (browserPath !== undefined && pathname === browserPath) return 'browser'
  return dev ? 'ignore' : 'destroy'
}
