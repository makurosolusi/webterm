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
  doc.head.appendChild(link)
  return link
}
