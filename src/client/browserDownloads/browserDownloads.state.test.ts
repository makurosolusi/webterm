import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '../../shared/browser.downloads'
import { applyDownloadMsg, downloadCounts, etaSeconds, fileKind, isDownloadMsg, rowStatus, trackSpeed } from './browserDownloads.state'
import { downloadNotice } from './useBrowserDownloads'
import { formatBytes, formatEta, formatSpeed, sizeLine } from './browserDownloads.text'

const it1 = (o: Partial<DownloadItem> & { id: string }): DownloadItem => ({
  nodeId: 'n1', name: 'a.zip', url: '', host: 'h.example', received: 0, total: 0, state: 'inProgress', risky: false, startedAt: 1, ...o,
})

describe('message fold', () => {
  it('recognises the two messages; a list replaces, one item upserts', () => {
    expect(isDownloadMsg({ t: 'download' })).toBe(true)
    expect(isDownloadMsg({ t: 'tab' })).toBe(false)
    const a = it1({ id: 'a' })
    const listed = applyDownloadMsg([it1({ id: 'z' })], { t: 'downloads', id: 'n1', items: [a] })
    expect(listed).toEqual([a])
    expect(applyDownloadMsg(listed, { t: 'download', id: 'n1', item: { ...a, received: 5 } })[0].received).toBe(5)
    expect(applyDownloadMsg(listed, { t: 'download', id: 'n1', item: it1({ id: 'b' }) }).map((i) => i.id)).toEqual(['a', 'b'])
    expect(applyDownloadMsg(listed, { t: 'downloads', id: 'n1', items: [] })).toEqual([])
  })
})

describe('counts and speed', () => {
  it('counts active and waiting and averages the known fractions', () => {
    const c = downloadCounts([it1({ id: 'a', received: 10, total: 100 }), it1({ id: 'b', received: 90, total: 100 }), it1({ id: 'c', received: 5 }), it1({ id: 'd', state: 'completed', pending: true })])
    expect(c).toEqual({ active: 3, waiting: 1, fraction: 0.5 })
    expect(downloadCounts([it1({ id: 'x', received: 5 })]).fraction).toBeNull()
    expect(downloadCounts([])).toEqual({ active: 0, waiting: 0, fraction: null })
  })

  it('smooths the speed over samples and forgets finished downloads', () => {
    const s1 = trackSpeed({}, [it1({ id: 'a', received: 0 })], 0)
    expect(s1.a.bps).toBe(0)
    const s2 = trackSpeed(s1, [it1({ id: 'a', received: 1000 })], 1000)
    expect(s2.a.bps).toBe(1000)
    const s3 = trackSpeed(s2, [it1({ id: 'a', received: 1000 + 3000 })], 2000)
    expect(s3.a.bps).toBeCloseTo(1000 * 0.6 + 3000 * 0.4, 5)
    expect(trackSpeed(s3, [it1({ id: 'a', state: 'completed' })], 3000)).toEqual({})
  })

  it('time left needs both a size and a speed', () => {
    expect(etaSeconds({ received: 100, total: 1100 }, 100)).toBe(10)
    expect(etaSeconds({ received: 100, total: 0 }, 100)).toBeNull()
    expect(etaSeconds({ received: 100, total: 1100 }, 0)).toBeNull()
  })
})

describe('words and numbers', () => {
  it('formats bytes, speed and time left', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(50 * 1024 ** 2)).toBe('50 MB')
    expect(formatSpeed(2048)).toBe('2.0 KB/s')
    expect(formatEta(5)).toBe('5 s left')
    expect(formatEta(75)).toBe('1 min 15 s left')
    expect(formatEta(3900)).toBe('1 h 5 min left')
    expect(formatEta(Number.NaN)).toBe('')
    expect(sizeLine({ received: 1024, total: 2048, state: 'inProgress' })).toBe('1.0 KB of 2.0 KB')
    expect(sizeLine({ received: 1024, total: 0, state: 'inProgress' })).toBe('1.0 KB')
    expect(sizeLine({ received: 1024, total: 1024, state: 'completed' })).toBe('1.0 KB')
  })

  it('picks the file icon family from the extension', () => {
    expect(['a.png', 'a.mp3', 'a.mp4', 'a.tar.gz', 'a.ts', 'a.pdf', 'a.bin', 'noext', '.hidden'].map(fileKind)).toEqual(['image', 'audio', 'video', 'archive', 'code', 'text', 'file', 'file', 'file'])
  })

  it('maps item state to the row status', () => {
    expect(rowStatus({ state: 'inProgress' })).toBe('running')
    expect(rowStatus({ state: 'completed' })).toBe('done')
    expect(rowStatus({ state: 'failed' })).toBe('failed')
  })
})

describe('toasts', () => {
  it('speaks when a download starts, finishes or fails, and stays quiet otherwise', () => {
    expect(downloadNotice(undefined, it1({ id: 'a' }))).toMatchObject({ severity: 'info', title: 'Downloading a.zip' })
    expect(downloadNotice('inProgress', it1({ id: 'a', state: 'completed' }))).toMatchObject({ severity: 'info', title: 'Downloaded a.zip' })
    expect(downloadNotice('inProgress', it1({ id: 'a', state: 'completed', pending: true }))?.severity).toBe('warning')
    expect(downloadNotice('inProgress', it1({ id: 'a', state: 'failed', failure: 'disk_full' }))).toMatchObject({ severity: 'error', title: 'Download of a.zip failed: the disk is full' })
    expect(downloadNotice('inProgress', it1({ id: 'a', state: 'canceled' }))).toBeNull()
    expect(downloadNotice('inProgress', it1({ id: 'a', received: 9 }))).toBeNull() // progress
    expect(downloadNotice(undefined, it1({ id: 'a', state: 'completed' }))).toBeNull() // history seen on attach
    expect(downloadNotice('completed', it1({ id: 'a', state: 'missing' }))).toBeNull()
  })
})
