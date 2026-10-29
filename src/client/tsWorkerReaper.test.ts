import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTsWorkerReaper, TS_WORKER_STOP_GRACE_MS, type TsWorkerLanguage } from './tsWorkerReaper'

// Didorong persis seperti `lazyMonaco.tsx` mendorongnya: `live` berdiri untuk
// `editor.getModels()`, dan — seperti `onWillDisposeModel` Monaco — model MASIH ada di `live`
// saat `modelLeft` menyala, baru dilepas sesudahnya.
describe('tsWorkerReaper', () => {
  let live: string[]
  let stopped: TsWorkerLanguage[]
  let reaper: ReturnType<typeof createTsWorkerReaper>

  const open = (language: string) => { live.push(language); reaper.modelEntered(language) }
  const close = (language: string) => {
    reaper.modelLeft(language)
    live.splice(live.indexOf(language), 1)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    live = []
    stopped = []
    reaper = createTsWorkerReaper({ liveLanguageIds: () => live, stopWorker: (l) => stopped.push(l) })
  })
  afterEach(() => { reaper.dispose(); vi.useRealTimers() })

  it('mematikan worker setelah masa tenggang, saat model TS terakhir dibuang', () => {
    open('typescript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS - 1)
    expect(stopped).toEqual([])
    vi.advanceTimersByTime(1)
    expect(stopped).toEqual(['typescript'])
  })

  it('tidak mematikan selama masih ada model bahasa itu (dua node .ts, satu ditutup)', () => {
    open('typescript')
    open('typescript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual([])
  })

  it('tidak mematikan kalau file .ts dibuka ulang di dalam masa tenggang', () => {
    open('typescript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS / 2)
    open('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual([])
  })

  it('TS dan JS terpisah, dan satu timer untuk banyak kepergian', () => {
    open('typescript')
    open('javascript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual(['typescript'])
    close('javascript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual(['typescript', 'javascript'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tidak pernah menendang bahasa tanpa worker, atau yang sudah dimatikan', () => {
    open('json')
    close('json')
    expect(vi.getTimerCount()).toBe(0)
    open('typescript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual(['typescript'])
    reaper.modelLeft('typescript') // event nyasar setelah worker mati
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual(['typescript'])
  })

  it('perpindahan bahasa keluar dari TS dihitung sebagai kepergian', () => {
    open('typescript')
    reaper.modelLeft('typescript')
    live[0] = 'markdown'
    reaper.modelEntered('markdown')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual(['typescript'])
  })
})
