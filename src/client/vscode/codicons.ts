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
  // belakang, ia menang urutan dan semua ikon terkunci 16px.
  doc.head.prepend(link)
  return link
}
