// Templates ("factories", F6): ⌘K "New from Template…" and "Save as Template…". The instantiate form
// prompts each parameter (devcontainer template options / Warp workflow arguments) and lists, verbatim,
// every command and routine the template will create before anything is made.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Workspace } from '../../shared/workspace'
import type { TemplatesHostProps } from './TemplatesHost'
import {
  TEMPLATES_TEXT as T, deleteTemplate, downloadTemplate, importTemplate, instantiate, listTemplates, reviewOf, saveTemplate,
  type WebtermTemplate,
} from './templates.client'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function InstantiateForm({ t, activeWs, onBack, onDone, props }: { t: WebtermTemplate; activeWs: Workspace | null; onBack: () => void; onDone: () => void; props: TemplatesHostProps }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(t.params.map((p) => [p.id, p.default ?? (p.id === 'repo' && activeWs?.cwd ? activeWs.cwd : '')])))
  const [intoActive, setIntoActive] = useState(false)
  const [name, setName] = useState(t.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const review = useMemo(() => reviewOf(t), [t])
  const create = () => {
    setBusy(true); setError(null)
    instantiate(t.id, values, intoActive && activeWs ? { workspaceId: activeWs.id } : { name }).then((r) => {
      if ('workspace' in r) props.onCreated(r.workspace)
      else props.onPlace(r.nodes, r.bridges)
      if (r.routines.skipped) setError(T.routinesSkipped(r.routines.skipped))
      else onDone()
    }, (e) => setError(errText(e))).finally(() => setBusy(false))
  }
  return (
    <form className="flex flex-col gap-2 text-xs" onSubmit={(e) => { e.preventDefault(); create() }} data-testid="template-form">
      <h3 className="font-semibold">{t.name}</h3>
      {t.description && <p className="opacity-80">{t.description}</p>}
      {t.params.map((p) => (
        <div key={p.id} className="flex flex-col gap-1">
          <Label htmlFor={`tpl-${p.id}`}>{p.id}{p.description ? ` — ${p.description}` : ''}</Label>
          <Input id={`tpl-${p.id}`} value={values[p.id] ?? ''} list={p.enum ? `tpl-${p.id}-enum` : undefined}
            onChange={(e) => setValues((v) => ({ ...v, [p.id]: e.target.value }))} />
          {p.enum && <datalist id={`tpl-${p.id}-enum`}>{p.enum.map((o) => <option key={o} value={o} />)}</datalist>}
        </div>
      ))}
      <div className="flex items-center gap-1" role="group" aria-label={T.target}>
        <span>{T.target}:</span>
        <Button type="button" size="sm" variant={intoActive ? 'outline' : 'default'} aria-pressed={!intoActive} onClick={() => setIntoActive(false)}>{T.targetNew}</Button>
        {activeWs && <Button type="button" size="sm" variant={intoActive ? 'default' : 'outline'} aria-pressed={intoActive} onClick={() => setIntoActive(true)}>{T.targetActive}</Button>}
      </div>
      {!intoActive && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="tpl-ws-name">{T.workspaceName}</Label>
          <Input id="tpl-ws-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      )}
      {review.commands.length > 0 && <div><p>{T.commands}</p><ul data-testid="template-commands">{review.commands.map((c) => <li key={c}><code>{c}</code></li>)}</ul></div>}
      {review.routines.length > 0 && <div><p>{T.routines}</p><ul>{review.routines.map((r) => <li key={r}><code>{r}</code></li>)}</ul></div>}
      {review.worktrees > 0 && <p>{T.worktrees(review.worktrees)}</p>}
      {error && <p className="text-red-600" role="alert">{error}</p>}
      <div className="flex gap-1">
        <Button type="button" size="sm" variant="outline" onClick={onBack}>{T.back}</Button>
        <Button type="submit" size="sm" disabled={busy}>{busy ? T.creating : T.create}</Button>
      </div>
    </form>
  )
}

export function NewFromTemplateDialog({ onClose, ...props }: TemplatesHostProps & { onClose: () => void }) {
  const [templates, setTemplates] = useState<WebtermTemplate[]>([])
  const [picked, setPicked] = useState<WebtermTemplate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const reload = () => listTemplates().then(setTemplates, (e) => setError(errText(e)))
  useEffect(() => { void reload() }, [])
  const onFile = async (f: File | undefined) => {
    if (!f) return
    setError(null)
    try {
      setPicked(await importTemplate(JSON.parse(await f.text())))
      await reload()
    } catch (e) {
      setError(T.importFailed(errText(e)))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="templates-dialog">
        <DialogHeader>
          <DialogTitle>{T.pickTitle}</DialogTitle>
          <DialogDescription>{T.pickIntro}</DialogDescription>
        </DialogHeader>
        {picked ? <InstantiateForm t={picked} activeWs={props.activeWs} props={props} onBack={() => setPicked(null)} onDone={onClose} /> : (
          <>
            {templates.length === 0 ? <p className="text-xs opacity-70">{T.empty}</p> : (
              <ul className="flex flex-col gap-1 text-xs">
                {templates.map((t) => (
                  <li key={t.id} className="flex items-center gap-2">
                    <Button size="sm" variant="outline" className="flex-1 justify-start" onClick={() => setPicked(t)}>
                      {t.name}{t.builtin ? ` · ${T.builtin}` : ''}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => downloadTemplate(t)}>{T.export}</Button>
                    {!t.builtin && <Button size="sm" variant="ghost" onClick={() => deleteTemplate(t.id).then(reload, (e) => setError(errText(e)))}>{T.remove}</Button>}
                  </li>
                ))}
              </ul>
            )}
            <Input ref={file} type="file" accept="application/json,.json" className="hidden" aria-label={T.import} data-testid="template-import" onChange={(e) => void onFile(e.target.files?.[0])} />
            <Button size="sm" variant="outline" onClick={() => file.current?.click()}>{T.import}</Button>
          </>
        )}
        {error && !picked && <p className="text-xs text-red-600" role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

export function SaveAsTemplateDialog({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const [name, setName] = useState(ws.name)
  const [description, setDescription] = useState('')
  const [routines, setRoutines] = useState(true)
  const [saved, setSaved] = useState<WebtermTemplate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const save = () => { setError(null); saveTemplate(ws.id, name, description, routines).then(setSaved, (e) => setError(errText(e))) }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg" data-testid="save-template-dialog">
        <DialogHeader>
          <DialogTitle>{T.saveTitle}</DialogTitle>
          <DialogDescription>{T.saveIntro}</DialogDescription>
        </DialogHeader>
        {saved ? (
          <div className="flex flex-col gap-2 text-xs">
            <p role="status">{T.saved(saved.name)}</p>
            <Button size="sm" variant="outline" onClick={() => downloadTemplate(saved)}>{T.export}</Button>
          </div>
        ) : (
          <form className="flex flex-col gap-2 text-xs" onSubmit={(e) => { e.preventDefault(); save() }}>
            <Label htmlFor="tpl-name">{T.name}</Label>
            <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} />
            <Label htmlFor="tpl-desc">{T.description}</Label>
            <Input id="tpl-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            <div className="flex items-center gap-2">
              <Checkbox id="tpl-routines" checked={routines} onCheckedChange={(c) => setRoutines(c === true)} />
              <Label htmlFor="tpl-routines">{T.includeRoutines}</Label>
            </div>
            {error && <p className="text-red-600" role="alert">{error}</p>}
            <Button type="submit" size="sm" disabled={!name.trim()}>{T.save}</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
