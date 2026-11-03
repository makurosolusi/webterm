import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { VscodeQuickPick } from '@/components/vscode/vscodeQuickPick'
import type { VscodeQuickPickItem } from '@/components/vscode/vscodeQuickPick'
import type { PaletteCommand } from './output/outputCommands'
import './canvas-ui.css'

// Cluster kontrol kiri-bawah + command palette ⌘K. Porting dari nodeterm
// `src/renderer/canvas/Canvas.tsx` (.controls-cluster). Palette memakai primitif VS Code
// (`VscodeQuickPick`) supaya metriknya sama dengan permukaan VS Code lain di webterm.

export interface PaletteTarget {
  id: string
  label: string
  /** Metadata kanan yang IKUT dicari (tipe node). */
  hint?: string
}

/** Bentuk node React Flow yang dibutuhkan palette — longgar supaya `Node[]` bisa lewat tanpa cast. */
export interface CanvasNodeLike {
  id: string
  type?: string
  data?: Record<string, unknown>
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/** Chip shortcut palette. Dipisah dari komponen supaya bisa dites tanpa DOM. */
export function shortcutChip(platform: string): string {
  return /mac|iphone|ipad/i.test(platform) ? '⌘K' : 'Ctrl K'
}

/** Cocok subsequence case-insensitive — "ntr" cocok dengan "New TeRminal". */
export function subsequenceMatch(haystack: string, q: string): boolean {
  if (!q) return true
  const s = haystack.toLowerCase()
  let i = 0
  for (const ch of q.toLowerCase()) {
    i = s.indexOf(ch, i)
    if (i === -1) return false
    i++
  }
  return true
}

const isWordStart = (s: string, i: number): boolean => i === 0 || /[^\p{L}\p{N}]/u.test(s[i - 1])

/**
 * Lebih kecil = lebih baik; `null` = tidak cocok. Tier, terbaik dulu: substring label di awal kata,
 * substring label di mana pun, substring hint, subsequence label, subsequence label+hint.
 * Ranking HARUS sebelum cap: tanpa ini query pendek mengisi daftar dengan baris yang cuma
 * kebetulan punya huruf-hurufnya, dan node yang benar-benar berjudul itu terpotong (nodeterm #SEO).
 */
export function targetScore(t: PaletteTarget, q: string): number | null {
  const query = q.trim().toLowerCase()
  if (!query) return 0
  const label = t.label.toLowerCase()
  let at = label.indexOf(query)
  while (at !== -1) {
    if (isWordStart(label, at)) return 0
    at = label.indexOf(query, at + 1)
  }
  if (label.includes(query)) return 1
  if ((t.hint ?? '').toLowerCase().includes(query)) return 2
  if (subsequenceMatch(t.label, query)) return 3
  if (subsequenceMatch(`${t.label} ${t.hint ?? ''}`, query)) return 4
  return null
}

/** Target yang cocok, terbaik dulu, dibatasi `limit`. Urutan deklarasi dipertahankan dalam satu tier. */
export function rankTargets(targets: PaletteTarget[], q: string, limit: number): PaletteTarget[] {
  if (!q.trim()) return targets.slice(0, limit)
  const scored: { t: PaletteTarget; score: number; idx: number }[] = []
  targets.forEach((t, idx) => {
    const score = targetScore(t, q)
    if (score !== null) scored.push({ t, score, idx })
  })
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx)
  return scored.slice(0, limit).map((r) => r.t)
}

/** Node canvas → baris palette. Node tanpa judul tetap dapat label yang bisa dibaca. */
export function nodeTargets(nodes: CanvasNodeLike[]): PaletteTarget[] {
  return nodes.map((n) => {
    const d = n.data ?? {}
    const kind = text(d.kind) ?? n.type ?? 'node'
    const label = text(d.title) ?? text(d.agentId) ?? `${kind} ${n.id.slice(0, 6)}`
    return { id: n.id, label, hint: kind }
  })
}

/** Codicon per tipe node di palette (seragam dengan Add node di Dock); tipe lain = terminal. */
const KIND_ICONS: Record<string, string> = { agent: 'hubot', files: 'folder', editor: 'edit', browser: 'globe' }
export const kindIcon = (kind?: string): string => (kind && KIND_ICONS[kind]) || 'terminal'

export interface CanvasToolbarProps {
  nodes: CanvasNodeLike[]
  /** Dipanggil dengan id node terpilih di palette — pemanggil yang melakukan fitView. */
  onFocusNode: (id: string) => void
  onOpenExplorer: () => void
  onOpenSettings: () => void
  onOpenHelp: () => void
  /** Perintah non-node yang ikut tampil di palette (grup Commands). */
  commands?: PaletteCommand[]
  /** Hanya untuk tes/override; default dari navigator. */
  platform?: string
}

export default function CanvasToolbar({
  nodes,
  onFocusNode,
  onOpenExplorer,
  onOpenSettings,
  onOpenHelp,
  commands,
  platform,
}: CanvasToolbarProps) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const chip = shortcutChip(platform ?? navigator.userAgent)
  const items = useMemo<VscodeQuickPickItem[]>(
    () => [
      ...nodeTargets(nodes).map((target) => ({
        id: target.id,
        label: target.label,
        description: target.hint,
        group: 'Nodes',
        icon: <span className={`codicon codicon-${kindIcon(target.hint)}`} aria-hidden />,
      })),
      ...(commands ?? []).map((c) => ({ id: c.id, label: c.label, keybinding: c.keybinding, group: 'Commands' })),
    ],
    [nodes, commands],
  )

  const closePalette = useCallback(() => setPaletteOpen(false), [])
  const selectNode = useCallback(
    (id: string) => {
      setPaletteOpen(false)
      const command = commands?.find((c) => c.id === id)
      if (command) command.run()
      else onFocusNode(id)
    },
    [onFocusNode, commands],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <div className="controls-cluster">
        <Button className="cluster-search" aria-label="Command palette" title={`Command palette (${chip})`} onClick={() => setPaletteOpen(true)}>
          <span className="codicon codicon-search" aria-hidden />
          <span className="kbd">{chip}</span>
        </Button>
        <Button aria-label="Explorer" title="Explorer" onClick={onOpenExplorer}>
          <span className="codicon codicon-files" aria-hidden />
        </Button>
        <Button aria-label="Settings" title="Settings" onClick={onOpenSettings}>
          <span className="codicon codicon-settings-gear" aria-hidden />
        </Button>
        <Button aria-label="Help" title="Help" onClick={onOpenHelp}>
          <span className="codicon codicon-question" aria-hidden />
        </Button>
      </div>
      {paletteOpen && (
        <VscodeQuickPick
          open
          onClose={closePalette}
          ariaLabel="Find node"
          placeholder="Find a node by name or type…"
          emptyText="No matches"
          items={items}
          rank={rankNodeItem}
          onSelect={selectNode}
        />
      )}
    </>
  )
}

/** Ranking node untuk quick pick; `hint` (tipe node) tetap ikut dicari, seperti palette lama. */
function rankNodeItem(item: VscodeQuickPickItem, query: string): number | null {
  return targetScore({ id: item.id, label: item.label, hint: item.description }, query)
}
