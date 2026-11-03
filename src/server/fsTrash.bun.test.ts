// Buku-besar trash (`fsTrash.ts`) terhadap filesystem NYATA di $TMPDIR. Bun-only; matcher terbatas
// pada yang diekspos `bun-test.d.ts` (toBe/toContain). WEBTERM_DATA_DIR diarahkan ke temp per test.
import { test, expect } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { TRASH_RETENTION_MS, discardTrash, lookupTrash, reserveTrash, sweepTrash, trashRoot } from './fsTrash'

async function withData(fn: (data: string) => Promise<void>): Promise<void> {
  const data = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-trash-'))
  const prev = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = data
  try {
    await fn(data)
  } finally {
    if (prev === undefined) delete process.env.WEBTERM_DATA_DIR
    else process.env.WEBTERM_DATA_DIR = prev
    await fs.rm(data, { recursive: true, force: true })
  }
}

const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false)

test('reserveTrash creates <data>/trash/<id>/ with meta.json {origPath, deletedAt}', async () => {
  await withData(async (data) => {
    const before = Date.now()
    const slot = await reserveTrash('/some/where/note.txt')
    expect(slot.dest).toBe(npath.join(data, 'trash', slot.id, 'note.txt'))
    const meta = JSON.parse(await fs.readFile(npath.join(trashRoot(), slot.id, 'meta.json'), 'utf8')) as { origPath: string; deletedAt: number }
    expect(meta.origPath).toBe('/some/where/note.txt')
    expect(String(meta.deletedAt >= before && meta.deletedAt <= Date.now())).toBe('true')
  })
})

test('lookupTrash round-trips and reports where the stored item lives', async () => {
  await withData(async () => {
    const slot = await reserveTrash('/x/y/doc.md')
    const e = await lookupTrash(slot.id)
    expect('ok' in e).toBe(false)
    if ('ok' in e) return
    expect(e.origPath).toBe('/x/y/doc.md')
    expect(e.item).toBe(slot.dest)
  })
})

test('lookupTrash rejects traversal and malformed ids with EINVAL before touching disk', async () => {
  await withData(async (data) => {
    await fs.mkdir(npath.join(data, 'secret'))
    await fs.writeFile(npath.join(data, 'secret', 'meta.json'), JSON.stringify({ origPath: '/a/b', deletedAt: 1 }))
    for (const bad of ['../secret', '', '..', 'abc', '0123456789abcdef0', '0123456789ABCDEF', 'a/b']) {
      const r = await lookupTrash(bad)
      expect('ok' in r ? r.code : 'found').toBe('EINVAL')
    }
  })
})

test('lookupTrash: unknown id and corrupt meta are ENOENT', async () => {
  await withData(async () => {
    const miss = await lookupTrash('0123456789abcdef')
    expect('ok' in miss ? miss.code : 'found').toBe('ENOENT')
    const slot = await reserveTrash('/x/y')
    await fs.writeFile(npath.join(trashRoot(), slot.id, 'meta.json'), '{not json')
    const bad = await lookupTrash(slot.id)
    expect('ok' in bad ? bad.code : 'found').toBe('ENOENT')
    await fs.writeFile(npath.join(trashRoot(), slot.id, 'meta.json'), JSON.stringify({ origPath: 5 }))
    const shape = await lookupTrash(slot.id)
    expect('ok' in shape ? shape.code : 'found').toBe('ENOENT')
  })
})

test('discardTrash removes its own slot and ignores ids that are not slot ids (no rm outside trash)', async () => {
  await withData(async (data) => {
    const slot = await reserveTrash('/x/y')
    await fs.writeFile(npath.join(data, 'sentinel'), 'keep')
    await discardTrash('../sentinel')
    await discardTrash('..')
    expect(await exists(npath.join(data, 'sentinel'))).toBe(true)
    await discardTrash(slot.id)
    expect(await exists(npath.join(trashRoot(), slot.id))).toBe(false)
    expect(await exists(trashRoot())).toBe(true)
  })
})

test('sweepTrash removes entries older than retention and keeps fresh ones', async () => {
  await withData(async () => {
    const old = await reserveTrash('/x/old.txt')
    const fresh = await reserveTrash('/x/fresh.txt')
    await fs.writeFile(old.dest, 'old')
    await fs.writeFile(npath.join(trashRoot(), old.id, 'meta.json'), JSON.stringify({ origPath: '/x/old.txt', deletedAt: Date.now() - TRASH_RETENTION_MS - 60_000 }))
    expect(await sweepTrash()).toBe(1)
    expect(await exists(npath.join(trashRoot(), old.id))).toBe(false)
    expect(await exists(npath.join(trashRoot(), fresh.id))).toBe(true)
    // `now` bisa digeser: di luar retensi, entri segar ikut disapu.
    expect(await sweepTrash(Date.now() + TRASH_RETENTION_MS + 60_000)).toBe(1)
  })
})

test('sweepTrash falls back to folder mtime when meta is gone, and ignores names that are not slot ids', async () => {
  await withData(async () => {
    await fs.mkdir(trashRoot(), { recursive: true })
    const orphan = npath.join(trashRoot(), '0123456789abcdef')
    await fs.mkdir(orphan)
    const longAgo = new Date(Date.now() - TRASH_RETENTION_MS - 60_000)
    await fs.utimes(orphan, longAgo, longAgo)
    await fs.writeFile(npath.join(trashRoot(), 'keep.txt'), 'not a slot')
    await fs.mkdir(npath.join(trashRoot(), 'not-an-id'))
    expect(await sweepTrash()).toBe(1)
    expect(await exists(orphan)).toBe(false)
    expect(await exists(npath.join(trashRoot(), 'keep.txt'))).toBe(true)
    expect(await exists(npath.join(trashRoot(), 'not-an-id'))).toBe(true)
  })
})

test('sweepTrash with no trash folder yet is a no-op returning 0', async () => {
  await withData(async () => {
    expect(await sweepTrash()).toBe(0)
  })
})
