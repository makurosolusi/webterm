// Panel "Agent History" di bawah sidebar Sessions: sesi Claude/Codex lampau yang terindeks dari
// transcript di disk, difilter per workspace, dengan Resume yang membuka node agent di workspace
// yang tepat. Meniru Orca `docs/site/content/docs/agents/session-history.mdx` (scope Workspace/All,
// pencarian, Refresh, Resume). Teks produk bahasa Inggris.
import { useCallback, useEffect, useRef, useState } from 'react'
import './SessionHistory.css'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { placeNode, type ReopenDeps } from './closedHistory'
import { fetchSessionPage, type AgentSession } from './SessionHistory.api'
import { relativeTime, resumeNode, resumeProfile, targetWorkspace } from './SessionHistory.model'
import { useLiveSettings } from './useSettings'
import { randomId } from './randomId'
import type { Settings } from '../shared/settings'
import type { Workspace } from '../shared/workspace'

export interface SessionHistoryProps {
  /** Ikut sidebar Sessions: tertutup = tidak merender apa pun. */
  open: boolean
  activeWs: Workspace | null
  workspaces: readonly Workspace[]
  launch: Settings['agentLaunchCommands']
  deps: ReopenDeps
}

type Scope = 'workspace' | 'all'
const SEARCH_DEBOUNCE_MS = 250
const AGENT_LABEL: Record<AgentSession['agent'], string> = { claude: 'Claude', codex: 'Codex' }

export default function SessionHistory({ open, activeWs, workspaces, launch, deps }: SessionHistoryProps) {
  const settings = useLiveSettings()
  const [expanded, setExpanded] = useState(true)
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
    if (open && expanded && !noFolder) void load(0)
  }, [open, expanded, noFolder, load])

  const resume = (s: AgentSession) => {
    const node = resumeNode(s, launch, randomId, resumeProfile(s, workspaces, settings))
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

  if (!open) return null

  return (
    <section className={`agent-history nodrag${expanded ? ' agent-history--open' : ''}`} aria-label="Agent history">
      <div className="agent-history__head">
        <Button type="button" variant="ghost" size="sm" className="agent-history__toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          <span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} aria-hidden />
          <span className="agent-history__title">Agent History</span>
          {expanded && !noFolder && <span className="agent-history__count">{items.length} shown · {total}</span>}
        </Button>
        {expanded && (
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh agent history" title="Refresh" onClick={() => void load(0, true)}>
            <span className="codicon codicon-refresh" aria-hidden />
          </Button>
        )}
      </div>
      {expanded && (
        <>
          <div className="agent-history__controls">
            <div className="agent-history__scope" role="radiogroup" aria-label="Scope">
              {(['workspace', 'all'] as const).map((s) => (
                <Button key={s} type="button" size="xs" variant={scope === s ? 'default' : 'outline'} role="radio" aria-checked={scope === s} onClick={() => setScope(s)}>
                  {s === 'workspace' ? 'Workspace' : 'All'}
                </Button>
              ))}
            </div>
            <Input className="agent-history__search" type="search" placeholder="Search sessions" aria-label="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="agent-history__body nowheel">
            {noFolder && <p className="agent-history__empty">This workspace has no folder. Switch to All to see every session.</p>}
            {error && <p className="agent-history__error" role="alert">{error}</p>}
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
            {next !== null && (
              <Button type="button" variant="secondary" size="xs" className="agent-history__more" disabled={loading} onClick={() => void load(next)}>
                {loading ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
