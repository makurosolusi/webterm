// Cocokkan ukuran frame screencast dengan viewport yang terakhir dikirim; tiru Orca
// browser-screencast-viewport-fit.ts:7-80 (`isLiveFrameCompatibleWithViewport`). Murni, tanpa I/O.
import { SCREENCAST_MAX_DIM } from '../shared/browser.contract'
import type { ViewportMsg } from '../shared/browser.contract'

interface Size { width: number; height: number }

const isNear = (v: number, want: number) => Math.abs(v - want) <= Math.max(2, want * 0.02)
const isNearSize = (a: Size, b: Size) => isNear(a.width, b.width) && isNear(a.height, b.height)

/**
 * true bila frame berukuran viewport CSS, viewport x dpr, atau viewport x dpr yang diperkecil ke batas
 * `SCREENCAST_MAX_DIM`. Frame transisi saat resize (ukuran lama) = false, supaya tidak digambar melar.
 */
export function isFrameCompatible(img: Size, vp: ViewportMsg): boolean {
  const css = { width: vp.w, height: vp.h }
  const device = { width: Math.round(vp.w * vp.dpr), height: Math.round(vp.h * vp.dpr) }
  const scale = Math.min(1, SCREENCAST_MAX_DIM / device.width, SCREENCAST_MAX_DIM / device.height)
  const capped = { width: Math.round(device.width * scale), height: Math.round(device.height * scale) }
  return isNearSize(img, css) || isNearSize(img, device) || isNearSize(img, capped)
}

// Batas filter resize. Menyimpang dari Orca: kompositor Orca satu proses dan selalu mengirim frame berukuran baru,
// sedangkan stream jarak jauh kita bisa tak pernah mengirimnya (Chromium mengabaikan metrics, halaman diam, frame
// hilang). Tanpa batas, node membeku; lewat batas, filter mati dan frame terbaru digambar apa adanya.
export const RESIZE_FILTER_MAX_MS = 500
export const RESIZE_FILTER_MAX_DROPS = 10

/** Filter aktif sesudah resize: viewport baru + jumlah frame yang sudah dibuang. */
export interface ResizeFilter { vp: ViewportMsg; drops: number }

/** true = frame boleh digambar (cocok, atau sudah RESIZE_FILTER_MAX_DROPS frame dibuang); false = dibuang (dihitung). */
export function passesResizeFilter(f: ResizeFilter, img: Size): boolean {
  return isFrameCompatible(img, f.vp) || ++f.drops >= RESIZE_FILTER_MAX_DROPS
}
