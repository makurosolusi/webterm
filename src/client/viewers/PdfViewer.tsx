import { useState } from 'react'

export interface PdfViewerProps { src: string; name: string }

/**
 * PDF in a sandboxed iframe. These `allow-*` tokens are deliberate: Chrome refuses to render a PDF
 * in a strictly sandboxed iframe. The risk is small because `raw` forces
 * `Content-Type: application/pdf` + `nosniff`, so the file is never treated as HTML.
 */
export const PDF_SANDBOX = 'allow-same-origin allow-scripts'

export function PdfViewer({ src, name }: PdfViewerProps) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="viewer viewer-pdf">
      {!loaded && <span className="viewer-loading" role="status">Loading…</span>}
      <iframe src={src} title={name} sandbox={PDF_SANDBOX} referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} />
    </div>
  )
}
