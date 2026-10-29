// Section Agent: dua kunci di sini butuh lebih dari satu input — `customAgents` (daftar record)
// dan `agentLaunchCommands` (override per builtin). Bentuknya mengikuti nodeterm
// `src/renderer/components/settings/sections/{AgentsSection,CustomAgentsSection}.tsx`: satu kartu
// per agent custom, dan satu baris input per agent builtin untuk launch command.
import { DEFAULT_SETTINGS, type CustomAgent, type Settings } from '../shared/settings'
import {
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  FALLBACK_AGENT_COLOR,
  type AgentPermissionMode,
  type BuiltinAgentId,
} from '../shared/workspace'
import { ColorField, Field, SelectField, TextField, ToggleField } from './SettingsFields'
import { randomId } from './randomId'

const PERMISSION_OPTIONS: readonly { value: AgentPermissionMode; label: string }[] = [
  { value: 'manual', label: 'manual — tanya tiap aksi' },
  { value: 'auto', label: 'auto — default' },
  { value: 'acceptEdits', label: 'acceptEdits — edit file langsung disetujui' },
  { value: 'plan', label: 'plan — rencanakan dulu, jangan ubah apa pun' },
  { value: 'bypassPermissions', label: 'bypassPermissions — tanpa prompt' },
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
        label="Agent default"
        hint="Agent yang diluncurkan tombol quick-add."
        value={s.defaultAgent}
        options={agentOptions}
        onChange={(v) => onChange({ defaultAgent: v })}
      />
      <SelectField
        id="st-claudePermissionMode"
        label="Mode permission Claude"
        hint="Dipakai sesi Claude saat START — dikirim sebagai --permission-mode saat peluncuran. Shift+Tab tetap bisa memutar mode saat runtime."
        value={s.claudePermissionMode}
        options={PERMISSION_OPTIONS}
        onChange={(v) => onChange({ claudePermissionMode: v })}
      />
      <ToggleField
        id="st-hookReplyApprovals"
        label="Persetujuan hook dari canvas"
        hint="Saat on, sesi Claude diluncurkan dengan NODETERM_PERM_WAIT_SECS — hook permission menahan sejenak menunggu Approve/Deny dari canvas sebelum jatuh ke prompt interaktif biasa. Off = perilaku lama persis."
        value={s.hookReplyApprovals}
        onChange={(v) => onChange({ hookReplyApprovals: v })}
      />

      <Field
        label="Agent di menu Add"
        hint="Matikan agent yang tidak kamu pakai supaya menu Add tetap pendek."
      >
        <div className="st-chips">
          {agentOptions.map((o) => {
            const off = s.disabledAgents.includes(o.value)
            return (
              <button
                key={o.value}
                type="button"
                role="switch"
                aria-checked={!off}
                className={'st-chip' + (off ? ' is-off' : '')}
                onClick={() => toggleDisabled(o.value, !off)}
              >
                {o.label}
              </button>
            )
          })}
        </div>
      </Field>

      <Field
        label="Perintah peluncuran"
        hint={
          'Luncurkan agent builtin dengan perintahmu sendiri — mis. skrip wrapper yang memilih akun. ' +
          'Dipakai di semua jalur peluncuran (sesi baru, resume, restart), dengan flag seperti --resume ' +
          'ditempel SETELAHNYA, jadi perintahnya harus meneruskan argumennya (skrip shell diakhiri ' +
          '`exec claude "$@"`). Kosong = default builtin.'
        }
      >
        <div className="st-rows">
          {BUILTIN_AGENT_IDS.map((id: BuiltinAgentId) => (
            <div key={id} className="st-row">
              <span className="st-row-label" style={{ color: AGENT_CONFIG[id].color }}>
                {AGENT_CONFIG[id].label}
              </span>
              <input
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
        hint="Bawa CLI agent sendiri, atau bungkus harness builtin (mis. Claude) untuk mengarahkan inferensi ke proxy-mu. Variabel env TIDAK tersedia di sini — settings webterm melintas HTTP, dan env adalah satu-satunya tempat kredensial akan mendarat."
      >
        <button type="button" className="st-btn" onClick={addAgent}>Tambah agent</button>
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
    <div className="st-card">
      <TextField
        id={`st-ca-label-${agent.id}`}
        label="Label"
        value={agent.label}
        placeholder="mis. Claude (proxy)"
        onChange={(v) => onPatch(agent.id, { label: v })}
      />
      <SelectField
        id={`st-ca-base-${agent.id}`}
        label="Harness dasar"
        hint={
          base
            ? `Mewarisi kapabilitas ${base.label}: resume, context link, mode permission, minting session id.`
            : 'Opsional. Tanpa ini agent custom hanya dapat spawn + judul terminal, tidak lebih.'
        }
        value={agent.baseAgent ?? ''}
        options={[
          { value: '', label: 'Tidak ada (CLI mandiri)' },
          ...BUILTIN_AGENT_IDS.map((id) => ({ value: id as string, label: AGENT_CONFIG[id].label })),
        ]}
        onChange={(v) => onPatch(agent.id, { baseAgent: (v || undefined) as BuiltinAgentId | undefined })}
      />
      <TextField
        id={`st-ca-cmd-${agent.id}`}
        label="Perintah peluncuran"
        hint={
          base && !agent.launchCmd.trim()
            ? `Kosong memakai perintah base ("${base.launchCmd}").`
            : undefined
        }
        value={agent.launchCmd}
        placeholder={base ? base.launchCmd : 'mis. aider'}
        mono
        onChange={(v) => onPatch(agent.id, { launchCmd: v })}
      />
      <ColorField
        id={`st-ca-color-${agent.id}`}
        label="Warna node"
        value={agent.color || base?.color || FALLBACK_AGENT_COLOR}
        onChange={(v) => onPatch(agent.id, { color: v })}
      />
      <div className="st-card-foot">
        <code className="st-mono st-muted">{agent.id}</code>
        <button type="button" className="st-btn st-btn-danger" onClick={() => onRemove(agent.id)}>
          Hapus
        </button>
      </div>
    </div>
  )
}
