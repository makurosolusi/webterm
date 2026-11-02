export type DialogPlatform = 'windows' | 'mac' | 'linux'

/** Platform of the current browser, used to pick VS Code's dialog button order. */
export function detectDialogPlatform(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): DialogPlatform {
  if (/^win/i.test(platform)) return 'windows'
  if (/^mac|iphone|ipad/i.test(platform)) return 'mac'
  return 'linux'
}

/**
 * Orders dialog buttons the way VS Code's `rearrangeButtons` does. `buttons` is the
 * logical order `[primary, ..., cancel]`. Windows keeps primary first and moves cancel
 * last; macOS and Linux put cancel before the primary and the primary on the trailing
 * (right) edge, following the Apple and GNOME HIGs.
 */
export function arrangeDialogButtons<T>(
  buttons: readonly T[],
  cancelIndex: number | undefined,
  platform: DialogPlatform = detectDialogPlatform(),
): T[] {
  const result = [...buttons]
  if (result.length < 2 || cancelIndex === undefined || cancelIndex < 0 || cancelIndex >= result.length) {
    return platform === 'windows' ? result : result.reverse()
  }
  const [cancel] = result.splice(cancelIndex, 1)
  if (platform === 'windows') return [...result, cancel]
  result.splice(1, 0, cancel)
  return result.reverse()
}
