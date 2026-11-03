// Koordinat klien -> titik halaman Chromium (§4.8). Murni.

export interface Rect { left: number; top: number; width: number; height: number }

/**
 * Titik klien (clientX/Y) -> CSS px viewport halaman. `rect` dari `canvas.getBoundingClientRect()`
 * yang SUDAH berskala, jadi zoom React Flow tidak dibaca. null (event dibuang) bila rect/viewport
 * nol, negatif, atau ada angka non-finite.
 */
export function toPagePoint(
  rect: Rect,
  client: { x: number; y: number },
  viewport: { w: number; h: number },
): { x: number; y: number } | null {
  const nums = [rect.left, rect.top, rect.width, rect.height, client.x, client.y, viewport.w, viewport.h]
  if (!nums.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || viewport.w <= 0 || viewport.h <= 0) return null
  return {
    x: ((client.x - rect.left) / rect.width) * viewport.w,
    y: ((client.y - rect.top) / rect.height) * viewport.h,
  }
}
