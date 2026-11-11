/* --- Platform ------------------------------------------------------------------------------- */

function platformString(): string {
  if (typeof navigator === 'undefined') return ''
  const withData = navigator as Navigator & { userAgentData?: { platform?: string } }
  return withData.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
}

export function isMacPlatform(): boolean {
  return /mac|iphone|ipad/i.test(platformString())
}

export function isWindowsPlatform(): boolean {
  return /win/i.test(platformString())
}

/** Linux desktop (not Android): where middle-click pastes the primary selection by convention. */
export function isLinuxPlatform(): boolean {
  const p = platformString()
  return /linux/i.test(p) && !/android/i.test(p)
}

/** Platform yang dipakai keputusan chord. Injectable supaya bisa dites tanpa `navigator`. */
export interface KeyPlatform {
  isMac: boolean
  isWindows: boolean
}

export function hostPlatform(): KeyPlatform {
  return { isMac: isMacPlatform(), isWindows: isWindowsPlatform() }
}
