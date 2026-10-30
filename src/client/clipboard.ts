/** Fallback untuk origin non-secure (http/LAN): `navigator.clipboard` absen di sana. */
function execCommandCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0'
  // `select()` mencuri fokus dari helper textarea xterm; dikembalikan supaya mengetik tetap jalan.
  const prev = document.activeElement as HTMLElement | null
  document.body.appendChild(ta)
  try {
    ta.select()
    return document.execCommand('copy')
  } catch (err) {
    console.warn('clipboard: execCommand copy failed', err)
    return false
  } finally {
    ta.remove()
    prev?.focus?.()
  }
}

/** Tulis teks ke clipboard sistem. `true` bila berhasil lewat API async atau fallback `execCommand`. */
export async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (err) {
      console.warn('clipboard: writeText rejected, falling back to execCommand', err)
    }
  }
  return execCommandCopy(text)
}
