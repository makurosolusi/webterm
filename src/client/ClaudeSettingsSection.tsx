// Settings › Claude: everything about how webterm runs Claude, as grouped cards. Connection = the provider
// card (one choice + staged test). How Claude starts = one block saying what agents, Central and helpers
// really start with, then the launch profiles (badges from the server's resolver). Permissions = one
// 3-level choice (settings.approvalLevel.ts). Models = read-only ladder. Advanced (folded) = Central's own
// profile, the raw permission mode, the Add menu, custom agent CLIs and the automation token.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'
import { APPROVAL_LEVEL_TEXT } from '../shared/settings.approvalLevel'
import { APPROVAL_TEXT, ApprovalModeFields } from './ApprovalModeControl'
import { PermissionRoutingField } from './PermissionRoutingField'
import type { EffectiveClaudeLaunch } from '../shared/claudeLaunch/claudeLaunch.effective'
import type { AgentPermissionMode } from '../shared/workspace'
import { ClaudeProviderCard } from './ClaudeProviderCard'
import { CentralProfileField, ClaudeLaunchProfilesCard } from './claudeLauncher/ClaudeLaunchProfilesCard'
import { fetchEffectiveLaunch } from './claudeLauncher/claudeLaunch.client'
import { openSettingsAt } from './settings.link'
import { CustomAgentsSettings } from './SettingsAgents'
import { ModelsSettings } from './SettingsModels'
import { SelectField } from './SettingsFields'
import { SettingsAdvanced, SettingsGroup } from './SettingsControls'
import { SettingsMessage } from './SettingsMessage'
import { TokenAccessCard } from './TokenAccessCard'

export const CLAUDE_TEXT = {
  launch: 'How Claude starts',
  permissions: 'Permissions',
  models: 'Models',
  startsWith: 'New Claude agents, Central and helpers start with:',
  agentsStartWith: 'New Claude agents and helpers start with:',
  centralUses: (name: string): string => `Central uses ${name}.`,
  change: 'Change',
  effectiveLoading: 'Checking what Claude starts with…',
  effectiveFailed: (code: string): string => `Could not check what Claude starts with (${code}).`,
  retry: 'Retry',
  credential: {
    card: 'Credential: the key or endpoint above.',
    command: 'Credential: supplied by your command.',
    env: 'Credential: from the server environment.',
    login: 'Credential: your Claude Code login.',
  } as Record<EffectiveClaudeLaunch['credential'], string>,
  approvalLabel: APPROVAL_TEXT.allLabel,
  approval: APPROVAL_LEVEL_TEXT,
  rawMode: 'Claude permission mode',
  rawModeHint: 'Passed to Claude as --permission-mode when it starts. The choice above sets it for you.',
  rawModeLocked: 'Danger is on, so agents start without asking.',
  rawModeFix: 'Use Auto instead',
} as const

const PERMISSION_OPTIONS: readonly { value: AgentPermissionMode; label: string }[] = [
  { value: 'manual', label: 'Ask before every action' },
  { value: 'auto', label: 'Auto (default)' },
  { value: 'acceptEdits', label: 'Approve file edits automatically' },
  { value: 'plan', label: 'Plan only, change nothing' },
  { value: 'bypassPermissions', label: 'Never ask (no prompts)' },
]

/** The server's effective launch, reloaded when a setting it depends on changes (and on `reload`). */
function useEffectiveLaunch(s: Settings): { data: EffectiveClaudeLaunch | null; error: string | null; reload(): void } {
  const [data, setData] = useState<EffectiveClaudeLaunch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])
  useEffect(() => {
    const ac = new AbortController()
    setError(null)
    fetchEffectiveLaunch(ac.signal).then(setData).catch((e: unknown) => {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'error')
    })
    return () => ac.abort()
  }, [version, s.claudeLaunchProfiles, s.defaultClaudeProfileId, s.centralClaudeProfileId])
  return { data, error, reload }
}

/** "New Claude agents, Central and helpers start with: <command>" plus where the credential comes from. */
export function EffectiveLaunchLine({ effective: e, error, onRetry }: { effective: EffectiveClaudeLaunch | null; error: string | null; onRetry(): void }): React.JSX.Element {
  if (error) {
    return (
      <div className="st-facts" data-effective-launch>
        <SettingsMessage kind="error" action={{ label: CLAUDE_TEXT.retry, run: onRetry }}>{CLAUDE_TEXT.effectiveFailed(error)}</SettingsMessage>
      </div>
    )
  }
  if (!e) return <div className="st-facts" data-effective-launch><SettingsMessage kind="loading">{CLAUDE_TEXT.effectiveLoading}</SettingsMessage></div>
  const central = e.deviations.find((d) => d.who === 'central')
  return (
    <div role="status" className="st-facts" data-effective-launch>
      <p>{central ? CLAUDE_TEXT.agentsStartWith : CLAUDE_TEXT.startsWith} <code className="st-mono">{e.agents.command}</code></p>
      {central ? (
        <p>
          {CLAUDE_TEXT.centralUses(central.name)}{' '}
          <Button size="xs" variant="link" className="h-auto px-0" onClick={() => openSettingsAt('claude', 'centralClaudeProfileId')}>{CLAUDE_TEXT.change}</Button>
        </p>
      ) : null}
      <p className="st-hint">{CLAUDE_TEXT.credential[e.credential]}</p>
    </div>
  )
}

/** Rows under Advanced: Central's profile, the raw mode, the Add menu, custom agents, the automation token. */
const ADVANCED_ROWS = 5

export function ClaudeSettingsSection({ settings: s, onChange, projectId }: { settings: Settings; onChange(patch: SettingsPatch): void; projectId?: string }): React.JSX.Element {
  const effective = useEffectiveLaunch(s)
  return (
    <div className="st-claude" data-section="claude">
      <div data-claude-group="connection">
        <ClaudeProviderCard onSaved={effective.reload} />
        <SettingsGroup title={CLAUDE_TEXT.launch}>
          <EffectiveLaunchLine effective={effective.data} error={effective.error} onRetry={effective.reload} />
          <ClaudeLaunchProfilesCard settings={s} onChange={onChange} effective={effective.data} />
        </SettingsGroup>
      </div>
      <div data-claude-group="permissions">
        <SettingsGroup title={CLAUDE_TEXT.permissions}>
          <ApprovalModeFields settings={s} projectId={projectId} />
          <PermissionRoutingField settings={s} onChange={onChange} />
        </SettingsGroup>
      </div>
      <div data-claude-group="models">
        <SettingsGroup title={CLAUDE_TEXT.models}>
          <ModelsSettings />
        </SettingsGroup>
      </div>
      <div data-claude-group="advanced">
        <SettingsAdvanced count={ADVANCED_ROWS}>
          <CentralProfileField settings={s} onChange={onChange} />
          <SelectField id="st-claudePermissionMode" setting="claudePermissionMode" label="Claude permission mode" hint={CLAUDE_TEXT.rawModeHint}
            value={s.claudePermissionMode} options={PERMISSION_OPTIONS}
            lock={s.skipApprovals ? { reason: CLAUDE_TEXT.rawModeLocked, fix: { label: CLAUDE_TEXT.rawModeFix, run: () => onChange({ agentApprovalLevel: 'risky' }) } } : undefined}
            onChange={(v) => onChange({ claudePermissionMode: v })} />
          <CustomAgentsSettings settings={s} onChange={onChange} />
          <TokenAccessCard />
        </SettingsAdvanced>
      </div>
    </div>
  )
}
