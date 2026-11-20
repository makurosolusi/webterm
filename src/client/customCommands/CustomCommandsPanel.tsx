// The one custom-commands surface, used by the setup wizard's "Commands" step and by Settings: what webterm
// found on this machine, the tool folders to add, and what it found for this session only. State is per
// instance (no module cache); a failed load shows the reason with Retry.
import { ActionButton, useAction } from '@/components/ui/action'
import { SettingsMessage } from '../SettingsMessage'
import { COMMANDS_TEXT } from './commands.labels'
import { CodeText } from './commands.code'
import { CommandsFolders } from './CommandsFolders'
import { CommandsFound } from './CommandsFound'
import { CommandsTerminal } from './CommandsTerminal'
import { rescanCommands } from './commands.api'
import { useCommandsData } from './useCommandsData'

const T = COMMANDS_TEXT

export function CustomCommandsPanel(): React.JSX.Element {
  const { data, reload } = useCommandsData()
  const retry = useAction(reload, { label: T.retry, toast: 'never' })
  return (
    <div className="flex flex-col gap-4" data-custom-commands-panel>
      <p className="m-0 text-xs text-(--vscode-descriptionForeground)"><CodeText text={T.tip} /></p>
      {data.status === 'loading' ? <SettingsMessage kind="loading">{T.loading}</SettingsMessage> : null}
      {data.status === 'error' ? (
        <>
          <SettingsMessage kind="error">{T.loadFailed} {data.message}</SettingsMessage>
          <ActionButton size="sm" variant="outline" className="self-start" action={retry} busyLabel={T.retrying}>{T.retry}</ActionButton>
        </>
      ) : null}
      {data.status === 'ready' ? (
        <>
          <CommandsFound detected={data.detected} reload={reload} />
          <CommandsTerminal detected={data.detected} onActivity={async () => { await rescanCommands(); await reload() }} />
          <CommandsFolders paths={data.paths} reload={reload} />
        </>
      ) : null}
    </div>
  )
}
