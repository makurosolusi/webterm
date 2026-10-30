/** Decide what to do with an upgrade: in dev Vite shares this server and owns its HMR upgrades, so non-ws ones must be left alone. */
export function upgradeRoute(pathname: string, wsPath: string, dev: boolean): 'ws' | 'destroy' | 'ignore' {
  if (pathname === wsPath) return 'ws'
  return dev ? 'ignore' : 'destroy'
}
