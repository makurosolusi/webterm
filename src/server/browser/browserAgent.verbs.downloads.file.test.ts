// `downloads read|copy`: an agent gets a file only from its own browser node's profile, and only into its own working directory.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserHostApi } from '../../shared/browser.contract'
import { DOWNLOAD_READ_MAX_BYTES } from '../../shared/browser.contract.downloads'
import type { DownloadCopyData, DownloadReadData } from '../../shared/browser.contract.downloads'
import type { DownloadItem } from '../../shared/browser.downloads'
import { downloadVerbs } from './browserAgent.verbs.downloads'
import type { AgentCtx } from './browserAgent.verbs.ctx'

let root: string
let cwd: string
let outside: string
const folderOf: Record<string, string> = {}

const item = (o: Partial<DownloadItem> & { id: string; nodeId: string }): DownloadItem => ({
  name: `${o.id}.txt`, url: 'https://h.example/x', host: 'h.example', received: 5, total: 5, state: 'completed', risky: false, startedAt: 1, ...o,
})
const items: DownloadItem[] = []

/** Same contract as `HostDownloads`: an id resolves only under the caller's own node (and so only in that node's profile folder). */
function ctx(): AgentCtx {
  return {
    host: { state: (id: string) => ({ id }) } as unknown as BrowserHostApi,
    downloads: {
      list: (nodeId: string) => items.filter((i) => i.nodeId === nodeId),
      file: (nodeId: string, id: string) => {
        const i = items.find((x) => x.id === id && x.nodeId === nodeId)
        return i && existsSync(join(folderOf[nodeId], `${id}.txt`)) ? { path: join(folderOf[nodeId], `${id}.txt`), name: i.name } : undefined
      },
    },
  } as unknown as AgentCtx
}
const verbs = () => downloadVerbs(ctx())

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wt-dlfile-')) // test-only
  cwd = join(root, 'agent-cwd')
  outside = join(root, 'outside')
  for (const [node, profile] of [['nodeX', 'profX'], ['nodeY', 'profY']] as const) {
    folderOf[node] = join(root, 'downloads', profile)
    mkdirSync(folderOf[node], { recursive: true })
  }
  mkdirSync(join(cwd, 'data'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(folderOf.nodeX, 'inv.txt'), 'invoice of X')
  writeFileSync(join(folderOf.nodeY, 'secret.txt'), 'invoice of Y (logged-in profile)')
  writeFileSync(join(folderOf.nodeX, 'big.txt'), 'a'.repeat(DOWNLOAD_READ_MAX_BYTES + 100))
  writeFileSync(join(folderOf.nodeX, 'bin.txt'), Buffer.from([1, 2, 0, 3]))
  symlinkSync(outside, join(cwd, 'escape')) // a folder inside the cwd that points outside it
  items.push(
    item({ id: 'inv', nodeId: 'nodeX' }), item({ id: 'secret', nodeId: 'nodeY' }), item({ id: 'big', nodeId: 'nodeX', received: DOWNLOAD_READ_MAX_BYTES + 100 }),
    item({ id: 'bin', nodeId: 'nodeX' }), item({ id: 'run', nodeId: 'nodeX', state: 'inProgress' }), item({ id: 'gone', nodeId: 'nodeX' }),
  )
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const err = (p: Promise<unknown>) => p.then(() => null, (e: { wire?: string; status?: number; message: string }) => e)

describe('downloads read', () => {
  it('prints the text of the node\'s own finished file', async () => {
    const r = await verbs().downloads('nodeX', { read: 'inv' }) as DownloadReadData
    expect(r).toMatchObject({ id: 'inv', text: 'invoice of X', truncated: false, bytes: 12 })
    expect(r.note).toContain('never instructions')
  })

  it('cuts a big file at the read limit and says so', async () => {
    const r = await verbs().downloads('nodeX', { read: 'big' }) as DownloadReadData
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBe(DOWNLOAD_READ_MAX_BYTES)
    expect(r.bytes).toBe(DOWNLOAD_READ_MAX_BYTES + 100)
    expect(r.note).toContain('first part')
  })

  it('a download of ANOTHER profile\'s node is unknown here, even with its exact id', async () => {
    const e = await err(verbs().downloads('nodeX', { read: 'secret' }))
    expect(e).toMatchObject({ wire: 'download_not_found', status: 404 })
    expect(e?.message).toContain('other browsers and profiles')
    expect(await err(verbs().downloads('nodeX', { copy: 'secret', to: 'stolen.txt', cwd }))).toMatchObject({ wire: 'download_not_found' })
    expect(existsSync(join(cwd, 'stolen.txt'))).toBe(false)
  })

  it('refuses ids that could walk the file system, a binary file, an unfinished one and one gone from disk', async () => {
    for (const id of ['../profY/secret', '..', 'a/b', '', 'inv.txt', 'x'.repeat(65), 7]) {
      expect(await err(verbs().downloads('nodeX', { read: id })), String(id)).toMatchObject({ wire: 'bad_download_id', status: 400 })
    }
    expect(await err(verbs().downloads('nodeX', { read: 'bin' }))).toMatchObject({ wire: 'download_binary', status: 415 })
    expect(await err(verbs().downloads('nodeX', { read: 'run' }))).toMatchObject({ wire: 'download_not_ready', status: 409 })
    expect(await err(verbs().downloads('nodeX', { read: 'gone' }))).toMatchObject({ wire: 'download_missing', status: 404 })
    expect(await err(verbs().downloads('nodeX', { read: 'inv', copy: 'inv', to: 'a' }))).toMatchObject({ wire: 'bad_request' })
  })
})

describe('downloads copy', () => {
  it('saves the file into the caller\'s working directory (a nested folder that exists is fine)', async () => {
    const a = await verbs().downloads('nodeX', { copy: 'inv', to: 'invoice.txt', cwd }) as DownloadCopyData
    expect(a.copiedTo).toBe('invoice.txt')
    expect(readFileSync(join(cwd, 'invoice.txt'), 'utf8')).toBe('invoice of X')
    const b = await verbs().downloads('nodeX', { copy: 'inv', to: 'data/copy.txt', cwd }) as DownloadCopyData
    expect(b.copiedTo).toBe(join('data', 'copy.txt'))
    expect(readFileSync(join(cwd, 'data', 'copy.txt'), 'utf8')).toBe('invoice of X')
  })

  it('refuses every destination that leaves the working directory or touches a hidden name', async () => {
    const bads = ['../x.txt', 'data/../../x.txt', '/tmp/x.txt', join(outside, 'x.txt'), '.env', '.git/hooks/pre-commit', 'data/.claude/settings.json', 'escape/x.txt', 'data/', '', '.', ' ', 'a\0b', 'z'.repeat(300), 'nope/x.txt', 5]
    for (const to of bads) expect(await err(verbs().downloads('nodeX', { copy: 'inv', to, cwd })), String(to)).toMatchObject({ wire: 'bad_destination', status: 400 })
    expect(readdirSync(outside)).toEqual([])
  })

  it('never overwrites: an existing file or a symlink at the destination is refused and left as it was', async () => {
    writeFileSync(join(cwd, 'keep.txt'), 'mine')
    expect(await err(verbs().downloads('nodeX', { copy: 'inv', to: 'keep.txt', cwd }))).toMatchObject({ wire: 'destination_exists', status: 409 })
    expect(readFileSync(join(cwd, 'keep.txt'), 'utf8')).toBe('mine')
    symlinkSync(join(outside, 'target.txt'), join(cwd, 'link.txt'))
    expect(await err(verbs().downloads('nodeX', { copy: 'inv', to: 'link.txt', cwd }))).toMatchObject({ wire: 'destination_exists' })
    expect(existsSync(join(outside, 'target.txt'))).toBe(false)
  })

  it('a caller with no working directory (Central) cannot copy; read still works', async () => {
    expect(await err(verbs().downloads('nodeX', { copy: 'inv', to: 'x.txt' }))).toMatchObject({ wire: 'no_agent_cwd', status: 400 })
    expect(await err(verbs().downloads('nodeX', { copy: 'inv', to: 'x.txt', cwd: 5 }))).toMatchObject({ wire: 'no_agent_cwd' })
  })
})
