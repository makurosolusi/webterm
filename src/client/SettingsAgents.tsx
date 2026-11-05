// Section Agent: dua kunci di sini butuh lebih dari satu input — `customAgents` (daftar record)
// dan `agentLaunchCommands` (override per builtin). Bentuknya mengikuti nodeterm
// `src/renderer/components/settings/sections/{AgentsSection,CustomAgentsSection}.tsx`: satu kartu
// per agent custom, dan satu baris input per agent builtin untuk launch command.
import type { CSSProperties } from 'react'
import { DEFAULT_SETTINGS, type CustomAgent, type Settings } from '../shared/settings'
import { Input } from '@/components/ui/input'
import {
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  FALLBACK_AGENT_COLOR,
  type AgentPermissionMode,
  type BuiltinAgentId,
} from '../shared/workspace'
import { ColorField, Field, SelectField, TextField, ToggleField } from './SettingsFields'
import { SettingsCheckbox } from './SettingsControls'
import { randomId } from './randomId'
import { ClaudeLaunchProfilesCard } from './claudeLauncher/ClaudeLaunchProfilesCard'

const PERMISSION_OPTIONS: readonly { value: AgentPermissionMode; label: string }[] = [
  { value: 'manual', label: 'manual — ask for every action' },
  { value: 'auto', label: 'auto — default' },
  { value: 'acceptEdits', label: 'acceptEdits — file edits are approved automatically' },
  { value: 'plan', label: 'plan — plan first, change nothing' },
  { value: 'bypassPermissions', label: 'bypassPermissions — no prompts' },
]

export function AgentSettings({
  settings: s,
  onChange,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const agentOptions = [
    ...BUILTIN_AGENT_IDS.map((id) => ({ value: id as string, label: AGENT_CONFIG[id].label })),
    ...s.customAgents.map((a) => ({ value: a.id, label: a.label || a.id })),
  ]

  const patchAgent = (id: string, patch: Partial<CustomAgent>): void =>
    onChange({ customAgents: s.customAgents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })

  const removeAgent = (id: string): void =>
    onChange({
      customAgents: s.customAgents.filter((a) => a.id !== id),
      // Buang id mati dari kunci yang merujuknya, jangan hanya dari daftar: `defaultAgent` yang
      // menunjuk agent terhapus akan menjadikan tombol quick-add menjalankan `custom:<uuid>`
      // sebagai perintah shell.
      defaultAgent: s.defaultAgent === id ? DEFAULT_SETTINGS.defaultAgent : s.defaultAgent,
      disabledAgents: s.disabledAgents.filter((d) => d !== id),
    })

  const addAgent = (): void =>
    onChange({
      customAgents: [
        ...s.customAgents,
        { id: `custom:${randomId()}`, label: 'Custom agent', launchCmd: '' },
      ],
    })

  const toggleDisabled = (id: string, disabled: boolean): void =>
    onChange({
      disabledAgents: disabled
        ? [...new Set([...s.disabledAgents, id])]
        : s.disabledAgents.filter((d) => d !== id),
    })

  return (
    <>
      <SelectField
        id="st-defaultAgent"
        setting="defaultAgent"
        label="Agent default"
        hint="The agent launched by the quick-add button."
        value={s.defaultAgent}
        options={agentOptions}
        onChange={(v) => onChange({ defaultAgent: v })}
      />
      <SelectField
        id="st-claudePermissionMode"
        setting="claudePermissionMode"
        label="Claude permission mode"
        hint="Used by Claude sessions at START — passed as --permission-mode at launch. Shift+Tab can still cycle modes at runtime."
        value={s.claudePermissionMode}
        options={PERMISSION_OPTIONS}
        onChange={(v) => onChange({ claudePermissionMode: v })}
      />
      <ToggleField
        id="st-hookReplyApprovals"
        setting="hookReplyApprovals"
        label="Hook approvals from the canvas"
        hint="When on, Claude permission requests wait briefly so you can Approve or Deny right from the canvas. If unanswered, Claude asks in its terminal as usual. Off = Claude always asks in the terminal."
        value={s.hookReplyApprovals}
        onChange={(v) => onChange({ hookReplyApprovals: v })}
      />

      <Field
        label="Agents in the Add menu"
        hint="Turn off agents you don’t use to keep the Add menu short."
        setting="disabledAgents"
        block
      >
        <div className="st-checklist">
          {agentOptions.map((o) => (
            <label key={o.value} className="st-checkrow">
              <SettingsCheckbox checked={!s.disabledAgents.includes(o.value)}
                onChange={(on) => toggleDisabled(o.value, !on)} />
              {o.label}
            </label>
          ))}
        </div>
      </Field>

      <ClaudeLaunchProfilesCard settings={s} onChange={onChange} />

      <Field
        label="Launch command"
        setting="agentLaunchCommands"
        hint={
          'Launch a builtin agent with your own command — e.g. a wrapper script that picks an account. ' +
          'Used on every launch path (new session, resume, restart), with flags such as --resume ' +
          'appended AFTER it, so the command must pass its arguments through (end a shell script with ' +
          '`exec claude "$@"`). Empty = builtin default. Claude uses the launch profiles above.'
        }
        block
      >
        <div className="st-rows">
          {BUILTIN_AGENT_IDS.filter((id) => id !== 'claude').map((id: BuiltinAgentId) => (
            <div key={id} className="st-row">
              <span className="st-row-label" style={{ '--agent-color': AGENT_CONFIG[id].color } as CSSProperties}>
                {AGENT_CONFIG[id].label}
              </span>
              <Input
                className="st-input st-mono"
                type="text"
                aria-label={`${AGENT_CONFIG[id].label} launch command`}
                placeholder={AGENT_CONFIG[id].launchCmd}
                value={s.agentLaunchCommands[id] ?? ''}
                onChange={(e) => {
                  // Field yang dikosongkan MENGHAPUS kuncinya alih-alih menyimpan '': absen adalah
                  // satu-satunya ejaan "default" yang disepakati semua konsumen.
                  const next = { ...s.agentLaunchCommands }
                  if (e.target.value) next[id] = e.target.value
                  else delete next[id]
                  onChange({ agentLaunchCommands: next })
                }}
              />
            </div>
          ))}
        </div>
      </Field>

      <Field
        label="Agent custom"
        hint="Bring your own agent CLI, or wrap a builtin harness (e.g. Claude) to route inference through your proxy. Env variables are NOT available here — webterm settings travel over HTTP, and env is the only place credentials would land."
        block
      >
        <button type="button" className="st-button" onClick={addAgent}>Add agent</button>
      </Field>
      <div className="st-cards">
        {s.customAgents.map((a) => (
          <CustomAgentCard key={a.id} agent={a} onPatch={patchAgent} onRemove={removeAgent} />
        ))}
      </div>
    </>
  )
}

function CustomAgentCard({
  agent,
  onPatch,
  onRemove,
}: {
  agent: CustomAgent
  onPatch: (id: string, patch: Partial<CustomAgent>) => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  const base = agent.baseAgent ? AGENT_CONFIG[agent.baseAgent] : undefined
  return (
    <section className="st-card" aria-label={agent.label || agent.id}>
      <TextField
        id={`st-ca-label-${agent.id}`}
        label="Label"
        value={agent.label}
        placeholder="e.g. Claude (proxy)"
        onChange={(v) => onPatch(agent.id, { label: v })}
      />
      <SelectField
        id={`st-ca-base-${agent.id}`}
        label="Base harness"
        hint={
          base
            ? `Inherits ${base.label} capabilities: resume, context link, permission mode, session id minting.`
            : 'Optional. Without it a custom agent only gets spawn + terminal title, nothing more.'
        }
        value={agent.baseAgent ?? ''}
        options={[
          { value: '', label: 'None (standalone CLI)' },
          ...BUILTIN_AGENT_IDS.map((id) => ({ value: id as string, label: AGENT_CONFIG[id].label })),
        ]}
        onChange={(v) => onPatch(agent.id, { baseAgent: (v || undefined) as BuiltinAgentId | undefined })}
      />
      <TextField
        id={`st-ca-cmd-${agent.id}`}
        label="Launch command"
        hint={
          base && !agent.launchCmd.trim()
            ? `Empty uses the base command ("${base.launchCmd}").`
            : undefined
        }
        value={agent.launchCmd}
        placeholder={base ? base.launchCmd : 'e.g. aider'}
        mono
        onChange={(v) => onPatch(agent.id, { launchCmd: v })}
      />
      <ColorField
        id={`st-ca-color-${agent.id}`}
        label="Node color"
        value={agent.color || base?.color || FALLBACK_AGENT_COLOR}
        onChange={(v) => onPatch(agent.id, { color: v })}
      />
      <div className="st-card-foot">
        <code className="st-mono st-muted">{agent.id}</code>
        <button type="button" className="st-button" onClick={() => onRemove(agent.id)}>
          Remove
        </button>
      </div>
    </section>
  )
}
