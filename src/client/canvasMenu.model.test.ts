import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_CANVAS_HINT,
  MENU_LABELS,
  buildCanvasMenuRows,
  isSeparator,
  type CanvasMenuContext,
  type CanvasMenuHandlers,
  type CanvasMenuRow,
} from './canvasMenu.model'

const handlers = (over: Partial<CanvasMenuHandlers> = {}): CanvasMenuHandlers => ({
  addTerminal: vi.fn(),
  addAgent: vi.fn(),
  addFiles: vi.fn(),
  fitView: vi.fn(),
  selectAll: vi.fn(),
  ...over,
})

const ctx = (over: Partial<CanvasMenuContext> = {}): CanvasMenuContext => ({
  nodeCount: 3,
  disabledAgents: [],
  customAgents: [],
  agentLaunchCommands: {},
  ...over,
})

/** Key baris non-separator, urut — bentuk menu diperiksa lewat ini, bukan lewat index telanjang. */
const keys = (rows: CanvasMenuRow[]): string[] =>
  rows.flatMap((r) => (isSeparator(r) ? [] : [r.key]))

const item = (rows: CanvasMenuRow[], key: string) => {
  const found = rows.find((r) => !isSeparator(r) && r.key === key)
  if (!found || isSeparator(found)) throw new Error(`baris ${key} tidak ada`)
  return found
}

describe('buildCanvasMenuRows — bentuk menu', () => {
  it('menaikkan Claude Code dan Codex ke level atas, sisanya ke submenu', () => {
    const rows = buildCanvasMenuRows(handlers(), ctx())
    expect(keys(rows)).toEqual([
      'terminal',
      'agent:claude',
      'agent:codex',
      'agent-group',
      'files',
      'select-all',
      'fit-view',
    ])
    expect(item(rows, 'terminal').label).toBe(MENU_LABELS.terminal)
    expect(item(rows, 'agent-group').label).toBe(MENU_LABELS.agentGroup)
    expect(item(rows, 'agent:claude').label).toBe('New Claude Code')
    expect(item(rows, 'agent:codex').label).toBe('New Codex')
  })

  it('submenu memuat builtin yang tersisa, TANPA yang sudah dipromosikan', () => {
    const rows = buildCanvasMenuRows(handlers(), ctx())
    const subKeys = item(rows, 'agent-group').children?.map((c) => c.key)
    expect(subKeys).toContain('agent:gemini')
    expect(subKeys).toContain('agent:cursor')
    expect(subKeys).not.toContain('agent:claude')
    expect(subKeys).not.toContain('agent:codex')
  })

  it('tepat satu separator, tepat sebelum aksi canvas', () => {
    const rows = buildCanvasMenuRows(handlers(), ctx())
    const at = rows.findIndex(isSeparator)
    expect(rows.filter(isSeparator)).toHaveLength(1)
    const after = rows.slice(at + 1)
    expect(keys(after)).toEqual(['select-all', 'fit-view'])
  })

  it('TIDAK memuat item nodeterm yang kemampuannya belum ada di webterm', () => {
    const labels = buildCanvasMenuRows(handlers(), ctx()).flatMap((r) =>
      isSeparator(r) ? [] : [r.label, ...(r.children ?? []).map((c) => c.label)],
    )
    // Penjaga regresi, bukan hiasan: menambahkan salah satu baris ini kembali sebagai stub yang
    // tidak melakukan apa-apa akan membuat test ini merah.
    for (const gone of [
      'New remote…',
      'New view',
      'Orchestrate',
      'Tidy canvas',
      'Arrange by lineage',
      'Restart idle agent sessions',
    ]) {
      expect(labels).not.toContain(gone)
    }
  })
})

describe('buildCanvasMenuRows — gerbang', () => {
  it('menghormati disabledAgents, termasuk saat yang disembunyikan adalah yang dipromosikan', () => {
    const rows = buildCanvasMenuRows(handlers(), ctx({ disabledAgents: ['codex', 'gemini'] }))
    expect(keys(rows)).not.toContain('agent:codex')
    expect(keys(rows)).toContain('agent:claude')
    expect(item(rows, 'agent-group').children?.map((c) => c.key)).not.toContain('agent:gemini')
  })

  it('submenu HILANG, bukan kosong, saat tidak ada agent yang tersisa', () => {
    const all = ctx({
      disabledAgents: ['claude', 'codex', 'antigravity', 'gemini', 'opencode', 'grok', 'copilot', 'cursor'],
    })
    const rows = buildCanvasMenuRows(handlers(), all)
    expect(keys(rows)).toEqual(['terminal', 'files', 'select-all', 'fit-view'])
  })

  it('agent custom ikut muncul di submenu dengan warnanya sendiri', () => {
    const rows = buildCanvasMenuRows(
      handlers(),
      ctx({ customAgents: [{ id: 'custom:a1', label: 'My Proxy', launchCmd: 'proxy', color: '#abcdef' }] }),
    )
    const sub = item(rows, 'agent-group').children ?? []
    const mine = sub.find((c) => c.key === 'agent:custom:a1')
    expect(mine?.label).toBe('My Proxy')
    expect(mine?.dot).toBe('#abcdef')
  })

  it('agent custom yang dinonaktifkan tidak muncul', () => {
    const rows = buildCanvasMenuRows(
      handlers(),
      ctx({
        customAgents: [{ id: 'custom:a1', label: 'My Proxy', launchCmd: 'proxy' }],
        disabledAgents: ['custom:a1'],
      }),
    )
    expect(item(rows, 'agent-group').children?.map((c) => c.key)).not.toContain('agent:custom:a1')
  })

  it('Select all nonaktif DAN beralasan saat canvas kosong', () => {
    const empty = item(buildCanvasMenuRows(handlers(), ctx({ nodeCount: 0 })), 'select-all')
    expect(empty.disabled).toBe(true)
    expect(empty.hint).toBe(EMPTY_CANVAS_HINT)
    const filled = item(buildCanvasMenuRows(handlers(), ctx({ nodeCount: 1 })), 'select-all')
    expect(filled.disabled).toBeFalsy()
  })

  it('tanpa handler selectAll barisnya tidak ada sama sekali', () => {
    const rows = buildCanvasMenuRows(handlers({ selectAll: undefined }), ctx())
    expect(keys(rows)).not.toContain('select-all')
    expect(keys(rows)).toContain('fit-view')
  })

  it('setiap baris yang bisa diklik punya aksi — menu tidak boleh menumbuhkan baris mati', () => {
    const rows = buildCanvasMenuRows(handlers(), ctx({ nodeCount: 0 }))
    const flat = rows.flatMap((r) => (isSeparator(r) ? [] : [r, ...(r.children ?? [])]))
    for (const r of flat) {
      // Baris bersubmenu memang tanpa onClick; selebihnya WAJIB punya.
      if (!r.children?.length) expect(typeof r.onClick, r.key).toBe('function')
    }
  })
})

describe('buildCanvasMenuRows — penyambungan aksi', () => {
  it('New terminal, file manager, dan Fit view memanggil handler-nya masing-masing', () => {
    const h = handlers()
    const rows = buildCanvasMenuRows(h, ctx())
    item(rows, 'terminal').onClick?.()
    item(rows, 'files').onClick?.()
    item(rows, 'fit-view').onClick?.()
    expect(h.addTerminal).toHaveBeenCalledTimes(1)
    expect(h.addFiles).toHaveBeenCalledTimes(1)
    expect(h.fitView).toHaveBeenCalledTimes(1)
  })

  it('agent builtin diluncurkan dengan perintah bawaannya', () => {
    const h = handlers()
    item(buildCanvasMenuRows(h, ctx()), 'agent:claude').onClick?.()
    expect(h.addAgent).toHaveBeenCalledWith('claude', 'claude')
  })

  it('override agentLaunchCommands menang atas perintah bawaan', () => {
    const h = handlers()
    const rows = buildCanvasMenuRows(h, ctx({ agentLaunchCommands: { claude: 'claude --profile work' } }))
    item(rows, 'agent:claude').onClick?.()
    expect(h.addAgent).toHaveBeenCalledWith('claude --profile work', 'claude')
  })

  it('agent custom diluncurkan dengan launchCmd-nya sendiri', () => {
    const h = handlers()
    const rows = buildCanvasMenuRows(
      h,
      ctx({ customAgents: [{ id: 'custom:a1', label: 'My Proxy', launchCmd: 'my-proxy --tui' }] }),
    )
    const sub = item(rows, 'agent-group').children ?? []
    sub.find((c) => c.key === 'agent:custom:a1')?.onClick?.()
    expect(h.addAgent).toHaveBeenCalledWith('my-proxy --tui', 'custom:a1')
  })

  it('custom ber-baseAgent tanpa launchCmd mengirim perintah base (termasuk override)', () => {
    const h = handlers()
    const customAgents = [{ id: 'custom:a2', label: 'Proxy', launchCmd: '', baseAgent: 'claude' as const }]
    const click = (cmds: CanvasMenuContext['agentLaunchCommands']) => {
      const rows = buildCanvasMenuRows(h, ctx({ customAgents, agentLaunchCommands: cmds }))
      ;(item(rows, 'agent-group').children ?? []).find((c) => c.key === 'agent:custom:a2')?.onClick?.()
    }
    click({})
    expect(h.addAgent).toHaveBeenLastCalledWith('claude', 'custom:a2')
    click({ claude: 'claude-work' })
    expect(h.addAgent).toHaveBeenLastCalledWith('claude-work', 'custom:a2')
  })
})
