// Settings › Claude › Advanced (dulu section Agent): `customAgents` (daftar record) butuh lebih dari satu input. Bentuknya mengikuti
// nodeterm `src/renderer/components/settings/sections/CustomAgentsSection.tsx`: satu kartu per agent
// custom. Claude's launch command lives in the launch profiles card; other CLIs have no builtin row.
import type { CustomAgent, Settings } from '../shared/settings'
import {
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  FALLBACK_AGENT_COLOR,
  type BuiltinAgentId,
} from '../shared/workspace'
import { ColorField, Field, SelectField, TextField } from './SettingsFields'
import { ComboboxField } from './SettingsPickerFields'
import { SettingsCheckbox } from './SettingsControls'
import { randomId } from './randomId'
import type { SettingsPatch } from '../shared/settings.patch'

/** Settings › Claude › Advanced: which agents the Add menu offers, and custom agent CLIs. */
export function CustomAgentsSettings({
  settings: s,
  onChange,
}: {
  settings: Settings
  onChange: (patch: SettingsPatch) => void
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

      <Field
        label="Custom agents"
        field="customAgents"
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
      <ComboboxField
        id={`st-ca-cmd-${agent.id}`}
        fieldId="agents.customLaunchCommand"
        label="Launch command"
        hint={
          base && !agent.launchCmd.trim()
            ? `Empty uses the base command ("${base.launchCmd}").`
            : undefined
        }
        value={agent.launchCmd}
        presets={[{ value: AGENT_CONFIG.claude.launchCmd }]}
        placeholder={base ? base.launchCmd : 'e.g. aider'}
        mono
        onCommit={(v) => onPatch(agent.id, { launchCmd: v })}
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
