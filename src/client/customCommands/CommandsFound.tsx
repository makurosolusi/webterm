// "Found on this machine": only the tools webterm detected (name, where it lives, and a compatibility
// badge when the binary is for another platform) plus Rescan, whose result is announced. Tools it looks
// for but did not find are just names inside one closed disclosure, never rows.
import { ActionButton, ActionResult, errorCause, useAction } from '@/components/ui/action'
import { Badge } from '@/components/ui/badge'
import type { CustomCommandDetected } from '../../shared/customCommands'
import { COMMANDS_TEXT } from './commands.labels'
import { shortenHome } from './commands.path'
import { rescanCommands } from './commands.api'

const T = COMMANDS_TEXT

function FoundRow({ item }: { item: CustomCommandDetected }): React.JSX.Element {
  const badge = item.compat === 'wrong_platform' || item.compat === 'wrong_arch' ? item.compat : null
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1 text-xs" data-command={item.name} data-found={item.found}>
      <span className="codicon codicon-pass" aria-hidden="true" />
      <span className="font-mono font-semibold">{item.name}</span>
      <span className="text-(--vscode-descriptionForeground)">{T.found.source[item.source]}</span>
      {item.path ? <span className="min-w-0 font-mono text-(--vscode-descriptionForeground) [overflow-wrap:anywhere]" title={item.path}>{shortenHome(item.path)}</span> : null}
      {badge ? <Badge variant="destructive" title={item.compatMessage ?? undefined}>{T.compat[badge]}</Badge> : null}
      {badge && item.compatMessage ? <span className="basis-full pl-5 text-destructive">{item.compatMessage}</span> : null}
    </li>
  )
}

export function CommandsFound({ detected, reload }: { detected: readonly CustomCommandDetected[]; reload(): Promise<void> }): React.JSX.Element {
  const rescan = useAction(async () => { const added = await rescanCommands(); await reload(); return added }, {
    label: T.rescan.button, success: T.rescan.result, failure: (e) => `${T.rescan.failed}: ${errorCause(e)}`, toast: 'never',
  })
  const found = detected.filter((d) => d.found)
  const known = detected.filter((d) => !d.found)
  return (
    <section className="flex flex-col gap-1.5" aria-label={T.found.title} data-commands-found>
      <div className="flex items-center gap-2">
        <h4 className="m-0 flex-1 text-xs font-semibold">{T.found.title}</h4>
        <ActionButton size="xs" variant="outline" action={rescan} busyLabel={T.rescan.busy}>{T.rescan.button}</ActionButton>
      </div>
      <ActionResult action={rescan} stamp="scanned" />
      {found.length === 0 ? (
        <p className="m-0 text-xs text-(--vscode-descriptionForeground)" data-commands-empty>{T.found.empty}</p>
      ) : (
        <ul className="m-0 list-none p-0">{found.map((d) => <FoundRow key={`${d.source}:${d.name}:${d.path ?? ''}`} item={d} />)}</ul>
      )}
      {known.length > 0 ? (
        <details className="text-xs" data-commands-known>
          <summary className="cursor-pointer py-1 text-(--vscode-descriptionForeground) max-sm:min-h-11">{T.found.known(known.length)}</summary>
          <p className="m-0 pb-1 font-mono text-(--vscode-descriptionForeground) [overflow-wrap:anywhere]">{known.map((d) => d.name).join(', ')}</p>
        </details>
      ) : null}
    </section>
  )
}
