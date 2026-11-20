// "Tool folders": the extra folders on PATH (exists / safe marks, Remove), Add folder (preset + free
// input combobox that remembers what you typed) and the folders found only for this session
// (Add permanently). One folder = every tool inside it works everywhere; no per-command registration.
import { useState } from 'react'
import { ActionButton, ActionResult, errorCause, useAction } from '@/components/ui/action'
import { Label } from '@/components/ui/label'
import { SettingsCombobox } from '../SettingsCombobox'
import { addToolFolder, removeToolFolder, type CommandPaths, type ExtraDir } from './commands.api'
import { COMMANDS_TEXT } from './commands.labels'
import { groupByDir, shortenHome } from './commands.path'

const T = COMMANDS_TEXT
type Reload = () => Promise<void>
/** Recent-folders key (`Settings.inputHistory`). */
export const COMMAND_FOLDER_HISTORY = 'commands.toolFolder'

function FolderRow({ item, reload }: { item: ExtraDir; reload: Reload }): React.JSX.Element {
  const remove = useAction(async () => { await removeToolFolder(item.dir); await reload() }, {
    label: T.folders.remove, success: () => T.folders.removed, failure: (e) => `${T.folders.removeFailed}: ${errorCause(e)}`, toast: 'never',
  })
  const problem = !item.exists ? T.folders.missing : !item.safe ? T.folders.unsafe : null
  return (
    <li className="flex flex-col gap-0.5 py-1 text-xs" data-folder={item.dir}>
      <div className="flex items-center gap-2">
        <span className={`codicon ${problem ? 'codicon-warning' : 'codicon-folder'}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere]" title={item.dir}>{shortenHome(item.dir)}</span>
        <ActionButton size="xs" variant="ghost" action={remove} busyLabel={T.folders.removeBusy} aria-label={T.folders.removeLabel(item.dir)}>{T.folders.remove}</ActionButton>
      </div>
      {problem ? <span className="pl-5 text-destructive">{problem}</span> : null}
      <div className="pl-5"><ActionResult action={remove} /></div>
    </li>
  )
}

function AddFolder({ common, reload }: { common: readonly string[]; reload: Reload }): React.JSX.Element {
  const [dir, setDir] = useState('')
  const add = useAction(async () => { const d = dir.trim(); await addToolFolder(d); await reload(); setDir(''); return d }, {
    label: T.add.button, success: T.add.done, failure: (e) => `${T.add.failed}: ${errorCause(e)}`, toast: 'never',
  })
  return (
    <div role="group" aria-labelledby="commands-add-label" className="flex flex-col gap-1.5 rounded-md border border-(--vscode-widget-border,var(--vscode-panel-border)) p-3" data-commands-add>
      <Label id="commands-add-label" className="text-xs font-semibold" htmlFor="commands-add-folder">{T.add.label}</Label>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-48 flex-1">
          <SettingsCombobox id="commands-add-folder" fieldId={COMMAND_FOLDER_HISTORY} mono value={dir} placeholder={T.add.placeholder}
            presets={common.map((value) => ({ value }))} onCommit={setDir} onDraft={setDir}
            validate={(v) => (v === '' || v.startsWith('/') ? null : T.add.notAbsolute)} />
        </div>
        <ActionButton size="sm" variant="outline" className="max-sm:min-h-11" action={add} busyLabel={T.add.busy} lock={dir.trim() ? undefined : { reason: T.add.needDir }}>{T.add.button}</ActionButton>
      </div>
      <p className="m-0 text-xs text-(--vscode-descriptionForeground)">{T.add.hint}</p>
      <ActionResult action={add} />
    </div>
  )
}

function SessionRow({ dir, names, reload }: { dir: string; names: string[]; reload: Reload }): React.JSX.Element {
  const keep = useAction(async () => { await addToolFolder(dir); await reload() }, {
    label: T.session.button, success: () => T.session.done, failure: (e) => `${T.session.failed}: ${errorCause(e)}`, toast: 'never',
  })
  return (
    <li className="flex flex-col gap-0.5 py-1 text-xs" data-session-dir={dir}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <span className="font-mono" title={dir}>{shortenHome(dir)}</span>
          <span className="text-(--vscode-descriptionForeground)"> · {names.join(', ')}</span>
        </span>
        <ActionButton size="xs" variant="outline" action={keep} busyLabel={T.session.busy} aria-label={T.session.buttonLabel(dir)}>{T.session.button}</ActionButton>
      </div>
      <ActionResult action={keep} />
    </li>
  )
}

export function CommandsFolders({ paths, reload }: { paths: CommandPaths; reload: Reload }): React.JSX.Element {
  const session = groupByDir(paths.session)
  return (
    <>
      <section className="flex flex-col gap-1.5" aria-label={T.folders.title} data-commands-folders>
        <h4 className="m-0 text-xs font-semibold">{T.folders.title}</h4>
        <p className="m-0 text-xs text-(--vscode-descriptionForeground)">{T.folders.hint}</p>
        {paths.extra.length === 0 ? (
          <p className="m-0 text-xs text-(--vscode-descriptionForeground)" data-folders-empty>{T.folders.empty}</p>
        ) : (
          <ul className="m-0 list-none p-0">{paths.extra.map((f) => <FolderRow key={f.dir} item={f} reload={reload} />)}</ul>
        )}
        <AddFolder common={paths.common} reload={reload} />
      </section>
      {session.length > 0 ? (
        <section className="flex flex-col gap-1.5" aria-label={T.session.title} data-commands-session>
          <h4 className="m-0 text-xs font-semibold">{T.session.title}</h4>
          <p className="m-0 text-xs text-(--vscode-descriptionForeground)">{T.session.hint}</p>
          <ul className="m-0 list-none p-0">{session.map((g) => <SessionRow key={g.dir} dir={g.dir} names={g.names} reload={reload} />)}</ul>
        </section>
      ) : null}
    </>
  )
}
