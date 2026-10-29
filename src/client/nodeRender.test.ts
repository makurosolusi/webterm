import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import { withLinkHandles } from './canvasStyle'

const src = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

/**
 * Callback yang disuntikkan ke `data` node dari luar komponen. Sengaja menyebut nama callback-nya:
 * `{ ...n.data, sessionId }` di dalam `onSession` adalah tulisan state yang sah dan bukan sasaran.
 */
const injectsCallbackIntoData = (s: string) => /data:\s*\{[^}]*\b(onSession|onToggleHideLinks)\b/.test(s)
const memoized = (s: string, name: string) => new RegExp(String.raw`export default memo\(${name}\)`).test(s)
/** `nodeTypes` harus literal top-level: dibentuk ulang saat render = React Flow me-remount node. */
const nodeTypesIsModuleConstant = (s: string) => /^export const nodeTypes = \{/m.test(s) && !/useMemo/.test(s)

// Bentuk lama, persis seperti sebelum callback pindah ke context. Dipakai untuk membuktikan
// guard di bawah benar-benar menggigit, bukan cocok karena polanya mustahil ditemukan.
const OLD_INJECTION = '{ ...base, data: { ...n.data, onSession, onToggleHideLinks: () => onToggleHideLinks(n.id) } }'

describe('churn data node', () => {
  it('App tidak menyuntikkan callback apa pun ke `data` node', () => {
    const app = src('App.tsx')
    expect(injectsCallbackIntoData(app)).toBe(false)
    // `flowNodes` tinggal pemetaan handle saja — satu baris tanpa `data` sama sekali.
    expect(app).toMatch(/const flowNodes = useMemo\(\(\) => nodes\.map\(withLinkHandles\), \[nodes\]\)/)
  })

  it('guard suntikan menolak bentuk lamanya, dan melewatkan tulisan state yang sah', () => {
    expect(injectsCallbackIntoData(OLD_INJECTION)).toBe(true)
    expect(injectsCallbackIntoData('data: { ...n.data, sessionId: uuid }')).toBe(false)
  })

  it('callback sampai ke node lewat context, bukan prop drilling', () => {
    expect(src('App.tsx')).toMatch(/<NodeActionsProvider value={nodeActions}>/)
    expect(src('AgentNode.tsx')).toContain('useNodeActions()')
  })

  it('`hideLinks` TETAP di data node — ia state yang dipersist, bukan callback', () => {
    expect(src('AgentNode.tsx')).toMatch(/hideLinks={d\.hideLinks}/)
    expect(src('nodeActions.ts')).not.toContain('hideLinks?')
  })

  it('layout tersimpan tidak pernah membawa callback', () => {
    expect(injectsCallbackIntoData(src('store.ts'))).toBe(false)
    // toWsNode memilih field secara eksplisit; spread `...n.data` di sana akan membocorkannya.
    expect(src('store.ts')).not.toMatch(/data:\s*\{\s*\.\.\./)
  })

  it('withLinkHandles memulangkan node terminal/agent APA ADANYA', () => {
    // Identitas inilah yang bikin `memo` punya arti: node yang tak berubah harus objek yang sama.
    const term = { id: 'a', type: 'terminal', position: { x: 0, y: 0 }, data: {} } as Node
    const agent = { id: 'b', type: 'agent', position: { x: 0, y: 0 }, data: {} } as Node
    const files = { id: 'c', type: 'files', position: { x: 0, y: 0 }, data: {} } as Node
    expect(withLinkHandles(term)).toBe(term)
    expect(withLinkHandles(agent)).toBe(agent)
    // files/editor butuh handle stub, jadi di sana salinan baru memang disengaja.
    expect(withLinkHandles(files)).not.toBe(files)
    expect(withLinkHandles(files).handles).toHaveLength(2)
  })
})

describe('memo pada komponen node', () => {
  for (const name of ['TerminalNode', 'AgentNode', 'FilesNode', 'EditorNode']) {
    it(`${name} ter-memo`, () => {
      expect(memoized(src(`${name}.tsx`), name)).toBe(true)
    })
  }

  it('guard memo menolak export tanpa memo', () => {
    expect(memoized('export default TerminalNode\n', 'TerminalNode')).toBe(false)
    expect(memoized('export default function TerminalNode() {}\n', 'TerminalNode')).toBe(false)
  })

  it('wrapper editor ikut ter-memo — itu komponen yang dipanggil React Flow', () => {
    expect(src('nodeTypes.tsx')).toMatch(/editor: memo\(function EditorNodeType/)
  })

  it('nodeTypes tetap konstanta modul', () => {
    expect(nodeTypesIsModuleConstant(src('nodeTypes.tsx'))).toBe(true)
    expect(nodeTypesIsModuleConstant('const nodeTypes = useMemo(() => ({ terminal: TerminalNode }), [])')).toBe(false)
  })
})
