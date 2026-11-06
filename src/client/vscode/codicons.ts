import codiconHref from '@vscode/codicons/dist/codicon.css?url'

/** Id yang dicari `<vscode-icon>` untuk menyalin stylesheet codicon ke shadow DOM-nya. */
export const CODICON_STYLESHEET_ID = 'vscode-codicon-stylesheet'

/** Pasang satu `<link>` codicon di `<head>`: melayani kelas `.codicon` biasa dan `<vscode-icon>`. */
export function installCodicons(doc: Document = document): HTMLLinkElement {
  const existing = doc.getElementById(CODICON_STYLESHEET_ID)
  if (existing instanceof HTMLLinkElement) return existing
  const link = doc.createElement('link')
  link.id = CODICON_STYLESHEET_ID
  link.rel = 'stylesheet'
  link.href = codiconHref
  // Paling depan di <head>: aturan codicon.css `.codicon[class*='codicon-'] { font: … 16px/1 }` (0,2,0) harus
  // kalah dari aturan chrome bertingkat sama (`.vscode-activity-bar__icon > .codicon` 24px); dipasang di
  // belakang, ia menang urutan dan semua ikon terkunci 16px. Urutan saja TIDAK cukup: Monaco membawa salinan
  // aturan yang sama di chunk malasnya, disisipkan paling belakang saat node editor mount — ukuran chrome yang
  // bukan 16px wajib spesifisitas > (0,2,0), mis. `.x > .codicon[class*='codicon-']` (codicons.test.ts).
  doc.head.prepend(link)
  return link
}
