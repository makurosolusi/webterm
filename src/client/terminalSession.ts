/** Pesan yang ditulis ke terminal saat proses PTY berakhir. */
export function exitMessage(code: number): string {
  return `\r\n[process exited with code ${code}]`
}

interface FocusTarget {
  tagName: string
  classList: { contains(name: string): boolean }
  isContentEditable?: boolean
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * Bolehkah terminal merebut fokus dari `active`? Tidak dari input/dialog/rename. Textarea helper
 * xterm lain hanya boleh direbut bila `fromTerminal` (pengguna memilih node), tidak saat mount
 * (banyak terminal mount sekaligus; yang pertama menang).
 */
export function canClaimFocus(active: FocusTarget | null, fromTerminal: boolean): boolean {
  if (!active) return true
  const editable = EDITABLE_TAGS.has(active.tagName.toUpperCase()) || active.isContentEditable === true
  if (!editable) return true
  return fromTerminal && active.classList.contains('xterm-helper-textarea')
}

/** Link terminal hanya dibuka dengan Cmd+klik (macOS) / Ctrl+klik, supaya klik biasa tak lompat. */
export function openLinkOnModifiedClick(
  e: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>,
  uri: string,
  open: (uri: string) => void = (u) => { window.open(u, '_blank', 'noopener') },
): void {
  if (e.metaKey || e.ctrlKey) open(uri)
}
