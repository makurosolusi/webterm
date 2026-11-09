// View "Agent History" (badan side bar; judul & tombol sembunyi milik shell SideBar): sesi Claude lampau yang terindeks dari
// transcript di disk, difilter per workspace, dengan Resume yang membuka node agent di workspace
// yang tepat. Meniru Orca `docs/site/content/docs/agents/session-history.mdx` (scope Workspace/All,
// pencarian, Refresh, Resume). Teks produk bahasa Inggris.
import { useCallback, useEffect, useRef, useState } from 'react'
import './SessionHistory.css'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { placeNode, type ReopenDeps } from './closedHistory'
import { fetchSessionPage, type AgentSession } from './SessionHistory.api'
import { relativeTime, resumeNode, resumeProfile, targetWorkspace } from './SessionHistory.model'
import { useLiveSettings } from './useSettings'
import { randomId } from './randomId'
import type { Workspace } from '../shared/workspace'

export interface SessionHistoryProps {
  /** True selama view ini tampil di side bar; tidak aktif = tidak merender & tidak memuat. */
  active: boolean
  activeWs: Workspace | null
  workspaces: readonly Workspace[]
  deps: ReopenDeps
}

type Scope = 'workspace' | 'all'
const SEARCH_DEBOUNCE_MS = 250
const AGENT_LABEL: Record<AgentSession['agent'], string> = { claude: 'Claude' }

export default function SessionHistory({ active, activeWs, workspaces, deps }: SessionHistoryProps) {
  const settings = useLiveSettings()
  const [scope, setScope] = useState<Scope>('workspace')
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('')
  const [items, setItems] = useState<AgentSession[]>([])
  const [total, setTotal] = useState(0)
  const [next, setNext] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Penanda permintaan terbaru: jawaban lambat untuk scope/pencarian lama tidak boleh menimpa yang baru.
  const seq = useRef(0)
  const cwd = scope === 'workspace' ? activeWs?.cwd : undefined
  const noFolder = scope === 'workspace' && !cwd

  useEffect(() => {
    const t = setTimeout(() => setQ(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const load = useCallback(async (offset: number, refresh = false) => {
    const my = ++seq.current
    setLoading(true)
    try {
      const page = await fetchSessionPage({ cwd, q, offset, refresh })
      if (my !== seq.current) return
      setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]))
      setTotal(page.total)
      setNext(page.nextOffset)
      setError(null)
    } catch (e) {
      if (my === seq.current) setError('Could not load agent history.')
      console.error('load agent history:', e)
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [cwd, q])

  useEffect(() => {
    if (active && !noFolder) void load(0)
  }, [active, noFolder, load])

  const resume = (s: AgentSession) => {
    const node = resumeNode(s, randomId, resumeProfile(s, workspaces, settings))
    const wsId = targetWorkspace(s, workspaces, activeWs?.id ?? null)
    if (!node || !wsId) {
      setError('This session cannot be resumed.')
      return
    }
    placeNode({ node, workspaceId: wsId }, deps).catch((e: unknown) => {
      setError('Resume failed. Try again.')
      console.error(`resume ${s.agent} session in workspace ${wsId}:`, e)
    })
  }

  if (!active) return null

  const retry = () => void load(0)
  return (
    <div className="agent-history-view nodrag" aria-label="Agent history">
      <div className="agent-history__toolbar">
        <Input className="agent-history__search" type="search" placeholder="Search sessions" aria-label="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="agent-history__bar">
          <div className="agent-history__scope" role="radiogroup" aria-label="Scope">
            {(['workspace', 'all'] as const).map((s) => (
              <Button key={s} type="button" size="xs" variant={scope === s ? 'default' : 'outline'} role="radio" aria-checked={scope === s} onClick={() => setScope(s)}>
                {s === 'workspace' ? 'Workspace' : 'All'}
              </Button>
            ))}
          </div>
          {!noFolder && <span className="agent-history__count">{items.length} shown · {total}</span>}
          <IconButton type="button" size="icon-sm" className="agent-history__refresh" label="Refresh agent history" disabled={noFolder} onClick={() => void load(0, true)}>
            <span className="codicon codicon-refresh" aria-hidden />
          </IconButton>
        </div>
      </div>
      <div className="agent-history__body nowheel">
        {noFolder && <p className="agent-history__empty">This workspace has no folder. Switch to All to see every session.</p>}
        {error && (
          <div className="agent-history__error" role="alert">
            <span>{error}</span>
            <Button type="button" variant="secondary" size="xs" onClick={retry}>Retry</Button>
          </div>
        )}
        {!noFolder && loading && items.length === 0 && <p className="agent-history__empty">Loading…</p>}
        {!noFolder && !loading && !error && items.length === 0 && (
          <p className="agent-history__empty">{q ? `No sessions match “${q}”.` : 'No agent sessions found here yet.'}</p>
        )}
        <ul className="agent-history__list">
          {!noFolder && items.map((s) => (
            <li key={`${s.agent}:${s.id}`} className="agent-history__row">
              <div className="agent-history__main" title={s.title ?? s.id}>
                <span className="agent-history__name">{s.title ?? 'Untitled session'}</span>
                <span className="agent-history__meta">
                  {AGENT_LABEL[s.agent]} · {relativeTime(s.endedAt)} · {s.messageCount} messages
                  {scope === 'all' && s.cwd ? ` · ${s.cwd}` : ''}
                </span>
              </div>
              <Button type="button" variant="secondary" size="xs" className="agent-history__resume" aria-label={`Resume ${s.title ?? s.id}`} onClick={() => resume(s)}>
                Resume
              </Button>
            </li>
          ))}
        </ul>
        {!noFolder && next !== null && (
          <Button type="button" variant="secondary" size="xs" className="agent-history__more" disabled={loading} onClick={() => void load(next)}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </div>
    </div>
  )
}
