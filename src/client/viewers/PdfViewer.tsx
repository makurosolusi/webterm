export interface PdfViewerProps { src: string; name: string }

/**
 * PDF di iframe ber-sandbox. Token `allow-*` ini sengaja: Chrome menolak merender PDF di iframe
 * sandbox ketat. Risikonya kecil karena `raw` memaksa `Content-Type: application/pdf` + `nosniff`,
 * jadi isi file tidak pernah diperlakukan sebagai HTML.
 */
export const PDF_SANDBOX = 'allow-same-origin allow-scripts'

export function PdfViewer({ src, name }: PdfViewerProps) {
  return (
    <div className="viewer viewer-pdf">
      <iframe src={src} title={name} sandbox={PDF_SANDBOX} referrerPolicy="no-referrer" />
    </div>
  )
}
