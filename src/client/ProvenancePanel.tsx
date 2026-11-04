// "What this session loaded" for one agent node (Devin's context provenance panel): every piece of
// context webterm or Claude Code puts into the session, with source, timing and size. Opened from the
// agent node's context menu; data from `/api/knowledge2/provenance` (server provenance/provenance.ts).
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TOKEN_HEADER } from './api'
import { peekToken } from './transportToken'

export const PROVENANCE_PATH = '/api/knowledge2/provenance'

/** Mirror of the server `ProvenanceItem`. */
export interface ProvenanceItem {
  kind: string
  label: string
  source: string
  when: 'system-prompt' | 'session-start' | 'on-touch' | 'on-demand' | 'claude-code'
  loaded: boolean
  chars: number
  tokens: number
  detail?: string
}
export interface ProvenanceView { items: ProvenanceItem[]; loadedChars: number; loadedTokens: number; root: string | null; touched: string[] }

export const PROVENANCE_TEXT = {
  menu: 'What this session loaded',
  menuHint: 'Lists the rules, cards, memory, tools and maps this agent session gets, with sources and sizes.',
  title: 'What this session loaded',
  intro: 'Rebuilt now from the same sources the session reads. On-demand items cost nothing until the agent calls them.',
  loading: 'Loading…',
  failed: (why: string) => `Cannot load provenance: ${why}`,
  total: (tokens: number, chars: number) => `In context: about ${tokens} tokens (${chars} chars)`,
  touched: (n: number) => (n === 1 ? '1 touched file decides which glob rules apply.' : `${n} touched files decide which glob rules apply.`),
  notLoaded: 'not loaded',
  when: {
    'system-prompt': 'system prompt', 'session-start': 'session start', 'on-touch': 'when a matching file is touched',
    'on-demand': 'on demand', 'claude-code': 'loaded by Claude Code',
  },
} as const

/** GET the provenance of `nodeId`; throws with the server error code. */
export async function fetchProvenance(nodeId: string): Promise<ProvenanceView> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const t = peekToken()
  if (t !== '') headers[TOKEN_HEADER] = t
  const res = await fetch(`${PROVENANCE_PATH}?nodeId=${encodeURIComponent(nodeId)}`, { headers })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `HTTP ${res.status}`)
  return out as ProvenanceView
}

export function ProvenancePanel({ nodeId, onClose }: { nodeId: string; onClose: () => void }): React.JSX.Element {
  const [view, setView] = useState<ProvenanceView | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    fetchProvenance(nodeId)
      .then((v) => { if (live) setView(v) })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)) })
    return () => { live = false }
  }, [nodeId])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl" data-testid="provenance-panel">
        <DialogHeader>
          <DialogTitle>{PROVENANCE_TEXT.title}</DialogTitle>
          <DialogDescription>{PROVENANCE_TEXT.intro}</DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="text-xs text-destructive">{PROVENANCE_TEXT.failed(error)}</p> : null}
        {!view && !error ? <p role="status" className="text-xs opacity-70">{PROVENANCE_TEXT.loading}</p> : null}
        {view ? (
          <>
            <p className="text-xs font-medium">{PROVENANCE_TEXT.total(view.loadedTokens, view.loadedChars)}</p>
            {view.touched.length ? <p className="text-xs opacity-70">{PROVENANCE_TEXT.touched(view.touched.length)}</p> : null}
            <ul className="flex flex-col gap-2 text-xs">
              {view.items.map((i) => (
                <li key={`${i.kind}:${i.label}`} data-kind={i.kind} data-loaded={i.loaded} className={i.loaded ? '' : 'opacity-60'}>
                  <div className="flex items-center gap-2">
                    <span className="flex-1 font-medium break-all">{i.label}</span>
                    <Badge variant="outline">{PROVENANCE_TEXT.when[i.when]}</Badge>
                    {i.loaded ? null : <Badge variant="secondary">{PROVENANCE_TEXT.notLoaded}</Badge>}
                    <span className="tabular-nums opacity-70">{`${i.tokens} tok`}</span>
                  </div>
                  <div className="opacity-70 break-all">{i.source}{i.detail ? ` · ${i.detail}` : ''}</div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
