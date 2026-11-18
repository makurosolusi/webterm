// View state of the comparison overlay (mode, slider positions, tolerance, size handling); pure reducer so it tests alone.
import { MAX_THRESHOLD } from './diff'
import type { SizeMode } from './diff'

export type CompareMode = 'swipe' | 'onion' | 'diff'
export const COMPARE_MODES: Array<{ id: CompareMode; label: string }> = [
  { id: 'swipe', label: 'Swipe' }, { id: 'onion', label: 'Onion skin' }, { id: 'diff', label: 'Difference' },
]
/** Default tolerance (percent of the largest colour distance): hides anti-aliasing and JPEG noise, keeps real changes. */
export const DEFAULT_THRESHOLD = 5

export interface CompareState { mode: CompareMode; swipe: number; onion: number; threshold: number; sizeMode: SizeMode }
export type CompareAction =
  | { type: 'mode'; mode: CompareMode }
  | { type: 'swipe'; value: number }
  | { type: 'onion'; value: number }
  | { type: 'threshold'; value: number }
  | { type: 'size'; sizeMode: SizeMode }

export const initialCompare: CompareState = { mode: 'swipe', swipe: 50, onion: 50, threshold: DEFAULT_THRESHOLD, sizeMode: 'fit' }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v)))

export function compareReducer(s: CompareState, a: CompareAction): CompareState {
  switch (a.type) {
    case 'mode': return s.mode === a.mode ? s : { ...s, mode: a.mode }
    case 'swipe': return { ...s, swipe: clamp(a.value, 0, 100) }
    case 'onion': return { ...s, onion: clamp(a.value, 0, 100) }
    case 'threshold': return { ...s, threshold: clamp(a.value, 0, MAX_THRESHOLD) }
    case 'size': return { ...s, sizeMode: a.sizeMode }
  }
}
