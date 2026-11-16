// Settings › Claude › Advanced: the Add-menu checklist and `customAgents` (a list of records, more than one
// input each). One
// card per custom agent, inside the "Custom agents" row, with an empty state. Claude's launch command lives
// in the launch profiles card; other CLIs have no builtin row.
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
import { Button } from '@/components/ui/button'
import type { SettingsPatch } from '../shared/settings.patch'

export const AGENTS_TEXT = {
  customHint: 'Run your own agent CLI, or wrap a built-in agent such as Claude to send it through your proxy. Keys belong in the server environment, not here.',
  empty: 'No custom agents yet.',
  add: 'Add agent',
  remove: 'Remove',
  newLabel: 'Custom agent',
  label: 'Label',
  color: 'Node color',
  base: 'Works like',
  noBase: 'Nothing (a plain CLI)',
  baseHint: (label: string): string => `Gets what ${label} can do in webterm: resume, linked context and permission modes.`,
  noBaseHint: 'Optional. Without it the agent only gets a terminal and a title.',
  emptyCommand: (cmd: string): string => `Empty uses "${cmd}".`,
} as const

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
        { id: `custom:${randomId()}`, label: AGENTS_TEXT.newLabel, launchCmd: '' },
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

      <Field label="Custom agents" field="customAgents" hint={AGENTS_TEXT.customHint} block>
        {s.customAgents.length === 0 ? <p className="st-hint m-0">{AGENTS_TEXT.empty}</p> : (
          <div className="st-cards">
            {s.customAgents.map((a) => (
              <CustomAgentCard key={a.id} agent={a} onPatch={patchAgent} onRemove={removeAgent} />
            ))}
          </div>
        )}
        <Button size="sm" variant="secondary" className="self-start" onClick={addAgent}>{AGENTS_TEXT.add}</Button>
      </Field>
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
        label={AGENTS_TEXT.label}
        value={agent.label}
        placeholder="e.g. Claude (proxy)"
        onChange={(v) => onPatch(agent.id, { label: v })}
      />
      <SelectField
        id={`st-ca-base-${agent.id}`}
        label={AGENTS_TEXT.base}
        hint={base ? AGENTS_TEXT.baseHint(base.label) : AGENTS_TEXT.noBaseHint}
        value={agent.baseAgent ?? ''}
        options={[
          { value: '', label: AGENTS_TEXT.noBase },
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
            ? AGENTS_TEXT.emptyCommand(base.launchCmd)
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
        label={AGENTS_TEXT.color}
        value={agent.color || base?.color || FALLBACK_AGENT_COLOR}
        onChange={(v) => onPatch(agent.id, { color: v })}
      />
      <div className="st-card-foot justify-end">
        <Button size="sm" variant="ghost" onClick={() => onRemove(agent.id)}>{AGENTS_TEXT.remove}</Button>
      </div>
    </section>
  )
}
