// Wires the Central chat's `/` commands (centralCommands) into a conversation view: the composer
// `completion`, a `seed` for `/help` and a missing argument, and an `onSend` that acts on a command
// instead of sending it. Kept out of chat/chatConversation so that file only passes three props.
import { useMemo, useRef, useState } from 'react'
import { fetchWorkspaces } from '../api'
import { expandNeedsYou, openCentralTab } from '../secondarySideBar.store'
import { listActiveSkills } from './centralControlApi'
import { createCentralCommands, type CentralSkill } from './centralCommands'
import { setCentralModel } from './centralModel'
import { chatErrorMessage } from '../chat/chatTransport'

/** What the chat host (ChatPanel) lends the commands. */
export interface CentralChatHost {
  /** The Central control panel is on: its tab shortcuts (/status, /halt…) and skills are offered. */
  centralEnabled: boolean
  newChat: () => void
  showHistory: () => void
  /** Test seams; default to the live skills route and the workspace list. */
  loadSkills?: () => Promise<CentralSkill[]>
  loadProjects?: () => Promise<string[]>
  setModel?: typeof setCentralModel
}

const liveProjects = (): Promise<string[]> => fetchWorkspaces().then((ws) => ws.map((w) => w.name))

export function useCentralChatCommands<R extends unknown[]>(
  host: CentralChatHost | undefined,
  send: (text: string, ...rest: R) => void,
  notice: (message: string) => void,
  /** Conversation `/model` applies to; absent = `/model` only reports that it is unavailable. */
  conversationId?: string,
  /** Called once the server stored a `/model` choice (the header badge reloads). */
  onModelSet?: () => void,
) {
  const hostRef = useRef(host)
  hostRef.current = host
  const [seed, setSeed] = useState<{ text: string; key: number; menu?: boolean }>()
  const enabled = host?.centralEnabled
  const commands = useMemo(() => (enabled === undefined ? undefined : createCentralCommands({
    centralEnabled: enabled,
    loadSkills: () => (hostRef.current?.loadSkills ?? listActiveSkills)(),
    loadProjects: () => (hostRef.current?.loadProjects ?? liveProjects)(),
  })), [enabled])

  const onSend = (text: string, ...rest: R): void => {
    const d = commands?.resolve(text) ?? { kind: 'send', text }
    const reseed = (next: string, menu?: boolean) => setSeed((s) => ({ text: next, key: (s?.key ?? 0) + 1, ...(menu ? { menu } : {}) }))
    if (d.kind === 'send') send(d.text, ...rest)
    else if (d.kind === 'usage') { notice(d.message); reseed(d.draft) }
    else if (d.kind === 'panel') openCentralTab(d.tab, d.halt)
    else if (d.kind === 'model') {
      if (!conversationId) notice('This chat cannot change its model.')
      else (hostRef.current?.setModel ?? setCentralModel)(conversationId, d.model, d.effort).then(() => onModelSet?.(), (e: unknown) => notice(chatErrorMessage(e)))
    }
    else if (d.action === 'new') hostRef.current?.newChat()
    else if (d.action === 'history') hostRef.current?.showHistory()
    else if (d.action === 'approvals') expandNeedsYou()
    else reseed('/', true)
  }

  return { completion: commands?.completion, seed, onSend }
}
