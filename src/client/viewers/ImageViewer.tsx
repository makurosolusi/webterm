export interface ImageViewerProps { src: string; name: string; onError: () => void }

/** Gambar (termasuk SVG) lewat `<img>`: SVG di sini tidak bisa menjalankan skrip, beda dengan iframe/object. */
export function ImageViewer({ src, name, onError }: ImageViewerProps) {
  return (
    <div className="viewer viewer-image">
      <img src={src} alt={name} draggable={false} onError={onError} />
    </div>
  )
}
