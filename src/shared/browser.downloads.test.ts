import { describe, expect, it } from 'vitest'
import { downloadFraction, downloadsOfNode, reduceDownloads, redactDownloadUrl, settleAfterRestart } from './browser.downloads'
import type { DownloadEvent, DownloadItem } from './browser.downloads'
import { DOWNLOAD_NAME_MAX, isRiskyName, sanitizeDownloadName, uniqueDownloadName } from './browser.downloads.name'

const begin = (id: string, o: Partial<Extract<DownloadEvent, { k: 'begin' }>> = {}): DownloadEvent =>
  ({ k: 'begin', id, nodeId: 'n1', url: 'https://u:pw@cdn.example/f/a.zip?sig=abc#frag', suggestedName: 'a.zip', now: 10, ...o })
const fold = (...evs: DownloadEvent[]): DownloadItem[] => evs.reduce<DownloadItem[]>((l, e) => reduceDownloads(l, e), [])

describe('reduceDownloads', () => {
  it('begin -> progress -> completed', () => {
    const l = fold(begin('a'), { k: 'progress', id: 'a', received: 40, total: 100 }, { k: 'progress', id: 'a', received: 100, total: 100 }, { k: 'done', id: 'a', state: 'completed', name: 'a (1).zip', now: 20 })
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({ state: 'completed', received: 100, total: 100, name: 'a (1).zip', endedAt: 20, host: 'cdn.example' })
  })

  it('redacts credentials, query and fragment from the stored address', () => {
    expect(fold(begin('a'))[0].url).toBe('https://cdn.example/f/a.zip')
    expect(redactDownloadUrl('data:text/plain;base64,AAAA')).toBe('data:')
    expect(redactDownloadUrl('not a url')).toBe('')
  })

  it('progress never goes backwards and keeps the last known total', () => {
    const l = fold(begin('a'), { k: 'progress', id: 'a', received: 50, total: 100 }, { k: 'progress', id: 'a', received: 30, total: 0 })
    expect(l[0]).toMatchObject({ received: 50, total: 100 })
  })

  it('canceled and failed are final: later events change nothing', () => {
    const c = fold(begin('a'), { k: 'done', id: 'a', state: 'canceled', now: 11 }, { k: 'progress', id: 'a', received: 9, total: 9 }, { k: 'done', id: 'a', state: 'completed', now: 12 })
    expect(c[0]).toMatchObject({ state: 'canceled', received: 0 })
    const f = fold(begin('b'), { k: 'fail', id: 'b', failure: 'too_large', now: 11 }, { k: 'done', id: 'b', state: 'completed', now: 12 })
    expect(f[0]).toMatchObject({ state: 'failed', failure: 'too_large' })
  })

  it('a completed file cannot be turned into a failure, but can go missing', () => {
    const l = fold(begin('a'), { k: 'done', id: 'a', state: 'completed', now: 11 }, { k: 'fail', id: 'a', failure: 'network', now: 12 })
    expect(l[0].state).toBe('completed')
    expect(reduceDownloads(l, { k: 'missing', id: 'a' })[0].state).toBe('missing')
  })

  it('duplicate begin and events for unknown ids are ignored', () => {
    const l = fold(begin('a'))
    expect(reduceDownloads(l, begin('a', { suggestedName: 'other.zip' }))).toBe(l)
    expect(reduceDownloads(l, { k: 'progress', id: 'zzz', received: 1, total: 1 })).toBe(l)
    expect(reduceDownloads(l, { k: 'remove', id: 'zzz' })).toEqual(l)
  })

  it('pending is set and cleared; remove drops the entry', () => {
    const p = fold(begin('a'), { k: 'pending', id: 'a', pending: true })
    expect(p[0].pending).toBe(true)
    expect('pending' in reduceDownloads(p, { k: 'pending', id: 'a', pending: false })[0]).toBe(false)
    expect(reduceDownloads(p, { k: 'remove', id: 'a' })).toEqual([])
  })

  it('caps history per node: the oldest finished go first, a running one never, other nodes are untouched', () => {
    let l: DownloadItem[] = []
    const add = (id: string, nodeId: string, finish: boolean) => {
      l = reduceDownloads(l, begin(id, { nodeId }), 3)
      if (finish) l = reduceDownloads(l, { k: 'done', id, state: 'completed', now: 20 }, 3)
    }
    add('run', 'n1', false)
    add('f1', 'n1', true)
    add('f2', 'n1', true)
    add('o1', 'n2', true)
    add('f3', 'n1', true) // 4th for n1: oldest FINISHED (f1) goes, `run` stays
    expect(l.map((i) => i.id)).toEqual(['run', 'f2', 'o1', 'f3'])
  })

  it('marks risky by the extension of the safe name', () => {
    expect(fold(begin('a', { suggestedName: 'setup.exe' }))[0].risky).toBe(true)
    expect(fold(begin('b', { suggestedName: 'notes.txt' }))[0].risky).toBe(false)
  })
})

describe('views and restart', () => {
  it('lists one node newest first and computes the fraction', () => {
    const l = fold(begin('a'), begin('b'), begin('c', { nodeId: 'n2' }))
    expect(downloadsOfNode(l, 'n1').map((i) => i.id)).toEqual(['b', 'a'])
    expect(downloadFraction({ received: 25, total: 100 })).toBe(0.25)
    expect(downloadFraction({ received: 5, total: 0 })).toBeNull()
    expect(downloadFraction({ received: 500, total: 100 })).toBe(1)
  })

  it('after a restart nothing is running and vanished files are marked missing', () => {
    const l = fold(begin('run'), begin('ok'), { k: 'done', id: 'ok', state: 'completed', now: 11 }, begin('gone'), { k: 'done', id: 'gone', state: 'completed', now: 11 })
    const s = settleAfterRestart(l, (i) => i.id !== 'gone', 99)
    expect(s.map((i) => [i.id, i.state])).toEqual([['run', 'failed'], ['ok', 'completed'], ['gone', 'missing']])
    expect(s[0]).toMatchObject({ failure: 'interrupted', endedAt: 99 })
  })
})

describe('file names', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\win\\system.ini', 'system.ini'],
    ['/abs/path/file.txt', 'file.txt'],
    ['a\u0000b\u001f.txt', 'ab.txt'],
    ['evil‮gpj.exe', 'evilgpj.exe'],
    ['..hidden', 'hidden'],
    ['name with: colon?.txt', 'name with_ colon_.txt'],
    ['trailing. ', 'trailing'],
    ['', 'download'],
    ['....', 'download'],
    ['///', 'download'],
  ])('sanitizes %j to %j', (input, out) => { expect(sanitizeDownloadName(input)).toBe(out) })

  it('bounds a long name but keeps its extension', () => {
    const n = sanitizeDownloadName(`${'x'.repeat(400)}.tar.gz`)
    expect(n.length).toBeLessThanOrEqual(DOWNLOAD_NAME_MAX)
    expect(n.endsWith('.gz')).toBe(true)
  })

  it('numbers a clash before the extension, ignoring case', () => {
    expect(uniqueDownloadName('a.txt', new Set())).toBe('a.txt')
    expect(uniqueDownloadName('a.txt', new Set(['A.TXT']))).toBe('a (1).txt')
    expect(uniqueDownloadName('a.txt', new Set(['a.txt', 'a (1).txt']))).toBe('a (2).txt')
    expect(uniqueDownloadName('noext', new Set(['noext']))).toBe('noext (1)')
    expect(uniqueDownloadName('.env', new Set(['.env']))).toBe('.env (1)')
  })

  it.each(['a.exe', 'x.APP', 'run.sh', 'i.pkg', 'd.dmg', 'b.bat', 'c.command', 'doc.pdf.exe'])('%s is risky', (n) => { expect(isRiskyName(n)).toBe(true) })
  it.each(['a.pdf', 'photo.png', 'exe', 'archive.zip', 'noext'])('%s is not risky', (n) => { expect(isRiskyName(n)).toBe(false) })
})
