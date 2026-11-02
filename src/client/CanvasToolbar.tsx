import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, CircleQuestionMark, FolderTree, Search, Settings, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import './canvas-ui.css'

// Cluster kontrol kanan-atas + command palette ⌘K. Porting dari nodeterm
// `src/renderer/canvas/Canvas.tsx` (.controls-cluster) dan `components/CommandPalette.tsx`.

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

export const PALETTE_LIMIT = 50

export interface CanvasToolbarProps {
  nodes: CanvasNodeLike[]
  /** Dipanggil dengan id node terpilih di palette — pemanggil yang melakukan fitView. */
  onFocusNode: (id: string) => void
  onOpenExplorer: () => void
  onOpenSettings: () => void
  onOpenHelp: () => void
  /** Hanya untuk tes/override; default dari navigator. */
  platform?: string
}

export default function CanvasToolbar({
  nodes,
  onFocusNode,
  onOpenExplorer,
  onOpenSettings,
  onOpenHelp,
  platform,
}: CanvasToolbarProps) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const chip = shortcutChip(platform ?? navigator.userAgent)
  const targets = useMemo(() => nodeTargets(nodes), [nodes])

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
        <Button className="cluster-search" aria-label="Command palette" title="Command palette" onClick={() => setPaletteOpen(true)}>
          <Search aria-hidden />
          <span className="kbd">{chip}</span>
        </Button>
        <Button aria-label="Explorer" title="Explorer" onClick={onOpenExplorer}>
          <FolderTree aria-hidden />
        </Button>
        <Button aria-label="Settings" title="Settings" onClick={onOpenSettings}>
          <Settings aria-hidden />
        </Button>
        <Button aria-label="Help" title="Help" onClick={onOpenHelp}>
          <CircleQuestionMark aria-hidden />
        </Button>
      </div>
      {paletteOpen && (
        <CommandPalette targets={targets} onPick={onFocusNode} onClose={() => setPaletteOpen(false)} />
      )}
    </>
  )
}

interface PaletteProps {
  targets: PaletteTarget[]
  onPick: (id: string) => void
  onClose: () => void
}

function CommandPalette({ targets, onPick, onClose }: PaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const items = useMemo(() => rankTargets(targets, query, PALETTE_LIMIT), [targets, query])

  const run = (t?: PaletteTarget) => {
    if (!t) return
    onPick(t.id)
    onClose()
  }

  // Portal ke body: palette harus menutupi canvas dan tidak ikut ter-transform viewport React Flow.
  return createPortal(
    <div className="palette-overlay nodrag nowheel" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Find node" onClick={(e) => e.stopPropagation()}>
        <Input
          className="palette__input"
          aria-label="Find node by name or type"
          autoFocus
          spellCheck={false}
          placeholder="Find a node by name or type…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          // Canvas mendengar keydown di document (Backspace menghapus node terpilih, panah mem-pan),
          // jadi event keyboard palette harus berhenti di sini.
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, items.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(items[active])
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
        />
        <div className="palette__list">
          {items.length === 0 ? (
            <div className="palette__empty">No matches</div>
          ) : (
            <>
              <div className="palette__section">Nodes</div>
              {items.map((t, i) => (
                <Button
                  key={t.id}
                  type="button"
                  variant="ghost"
                  className={`palette__item${i === active ? ' active' : ''}`}
                  aria-current={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(t)}
                >
                  <span className="palette__icon">
                    {t.hint === 'agent' ? <Bot aria-hidden /> : <Terminal aria-hidden />}
                  </span>
                  <span className="palette__label">{t.label}</span>
                  {t.hint && <span className="palette__hint">{t.hint}</span>}
                </Button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
