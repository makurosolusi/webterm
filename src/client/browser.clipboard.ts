// Clipboard untuk node browser: tulis hasil `copy` server, baca paste dari event (tanpa Clipboard API).

export type ClipboardResult = { ok: true } | { ok: false; error: string }

/** Tulis teks ke clipboard sistem; galat dikembalikan sebagai pesan (tanpa isi teks), bukan dilempar. */
export async function writeClipboard(text: string): Promise<ClipboardResult> {
  if (!navigator.clipboard?.writeText) {
    return { ok: false, error: 'browser clipboard write unavailable (needs a secure context)' }
  }
  try {
    await navigator.clipboard.writeText(text)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `browser clipboard write failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Teks polos dari event paste ('' bila tak ada); memakai `clipboardData` event, bukan `navigator.clipboard`. */
export function pastedText(e: { clipboardData: Pick<DataTransfer, 'getData'> | null }): string {
  return e.clipboardData?.getData('text/plain') ?? ''
}
