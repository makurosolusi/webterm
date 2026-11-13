// The one permission-mode control (Ask / Auto / Danger), in two shapes over the same save path
// (approvalMode.state.ts): the Settings rows (all projects, plus "This project") and the quiet text button in
// the Central chat composer toolbar (like Claude Code's mode line under the input, Cursor's composer mode
// picker). Danger asks once per change in the app AlertDialog.
import { DropdownMenu } from 'radix-ui'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { IconTooltip } from '@/components/ui/icon-button'
import { portalContainer } from '@/components/vscode/portalContainer'
import { useState } from 'react'
import type { Settings } from '../shared/settings'
import { APPROVAL_LEVEL_TEXT, type ApprovalLevel } from '../shared/settings.approvalLevel'
import { approvalLevelFor } from '../shared/settings.projectApprovalLevels'
import { Field, FieldSaveStatus } from './SettingsFields'
import { SettingsSegmented, SettingsSelect } from './SettingsControls'
import { useFieldSave } from './settingsSave'
import { settingsSaves, useLiveSettings } from './useSettings'
import {
  approvalSaveKey, MODE_ORDER, nextApprovalLevel, staleSessionsText, useApprovalModeChange, useCycleApprovalMode, type ApprovalModeChange, type ApprovalTarget,
} from './approvalMode.state'
import './agentChat/agentChatToolbar.css'
import './approvalMode.css'

export { MODE_ORDER } from './approvalMode.state'
const SAME_AS_ALL = 'inherit'

export const APPROVAL_TEXT = {
  allLabel: 'How much may agents do on their own?',
  projectLabel: 'This project',
  projectHint: 'Overrides the mode above for the open project only.',
  sameAsAll: (level: ApprovalLevel): string => `Same as all projects (${APPROVAL_LEVEL_TEXT[level].label})`,
  confirmTitle: 'Switch to Danger?',
  confirmBody: 'Agents will run commands, edit and delete files and push without asking; your Deny rules, spend limits and secret access still apply.',
  confirmAction: 'Switch to Danger',
  cancel: 'Cancel',
  chip: (level: ApprovalLevel, scoped: boolean): string => `Permission mode: ${APPROVAL_LEVEL_TEXT[level].label}${scoped ? ' (this project)' : ' (all projects)'}`,
  scopeProject: 'This project',
  scopeAll: 'All projects',
  /** Tooltip: the mode, where it applies, and one line of what it means. */
  tooltip: (level: ApprovalLevel, scoped: boolean): string =>
    `${APPROVAL_LEVEL_TEXT[level].label} in ${scoped ? 'this project' : 'all projects'}: ${MODE_MEANING[level]}`,
} as const

const MODE_MEANING: Record<ApprovalLevel, string> = {
  always: 'agents ask before every action that needs permission.',
  risky: 'routine work runs on its own; actions that cannot be undone ask first.',
  never: 'agents act without asking. Your Deny rules, spend limits and secret access still apply.',
}

/** Codicon per mode: shield (Ask), check-shield (Auto), warning (Danger). */
const MODE_ICON: Record<ApprovalLevel, string> = { always: 'shield', risky: 'workspace-trusted', never: 'warning' }

/** The Danger confirmation of `change`; renders nothing while nobody is asked. */
export function DangerConfirm({ change }: { change: ApprovalModeChange }): React.JSX.Element | null {
  if (!change.asking) return null
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) change.cancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{APPROVAL_TEXT.confirmTitle}</AlertDialogTitle>
          <AlertDialogDescription>{APPROVAL_TEXT.confirmBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>{APPROVAL_TEXT.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={change.confirm}>{APPROVAL_TEXT.confirmAction}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function StaleLine({ n }: { n: number }): React.JSX.Element | null {
  const text = staleSessionsText(n)
  return text ? <p className="st-hint approval-stale" role="status">{text}</p> : null
}

const OPTIONS = MODE_ORDER.map((v) => ({ value: v, label: APPROVAL_LEVEL_TEXT[v].label }))

/** Settings › Claude › Permissions: the mode for all projects (segmented, three choices) and, with a project open, its own. */
export function ApprovalModeFields({ settings: s, projectId }: { settings: Settings; projectId?: string }): React.JSX.Element {
  const change = useApprovalModeChange(s)
  const level = s.agentApprovalLevel
  const own = projectId ? s.projectApprovalLevels[projectId] : undefined
  const projectOptions = [{ value: SAME_AS_ALL, label: APPROVAL_TEXT.sameAsAll(level) }, ...OPTIONS]
  return (
    <>
      <Field label={APPROVAL_TEXT.allLabel} hint={APPROVAL_LEVEL_TEXT[level].hint} htmlFor="st-agentApprovalLevel" setting="agentApprovalLevel"
        tone={level === 'never' ? 'warning' : undefined}>
        <SettingsSegmented id="st-agentApprovalLevel" ariaLabel={APPROVAL_TEXT.allLabel} value={level} options={OPTIONS} onChange={(v) => change.choose({ scope: 'global' }, v)} />
      </Field>
      {projectId ? (
        <Field label={APPROVAL_TEXT.projectLabel} hint={own ? APPROVAL_LEVEL_TEXT[own].hint : APPROVAL_TEXT.projectHint}
          htmlFor="st-projectApprovalLevels" setting="projectApprovalLevels" tone={own === 'never' ? 'warning' : undefined}>
          <SettingsSelect id="st-projectApprovalLevels" value={own ?? SAME_AS_ALL} options={projectOptions}
            onChange={(v) => change.choose({ scope: 'workspace', workspaceId: projectId }, v === SAME_AS_ALL ? null : (v as ApprovalLevel))} />
        </Field>
      ) : null}
      <StaleLine n={change.stale} />
      <DangerConfirm change={change} />
    </>
  )
}

/** Central chat composer mode button: the EFFECTIVE mode of the open project; its menu picks a mode and where it applies. */
export function ApprovalModeChip({ workspaceId }: { workspaceId: string | null }): React.JSX.Element {
  const s = useLiveSettings()
  const change = useApprovalModeChange(s)
  const [scope, setScope] = useState<'workspace' | 'global'>(workspaceId ? 'workspace' : 'global')
  const target: ApprovalTarget = scope === 'workspace' && workspaceId ? { scope: 'workspace', workspaceId } : { scope: 'global' }
  const effective = approvalLevelFor(s, workspaceId)
  const shown = target.scope === 'global' ? s.agentApprovalLevel : effective
  const save = useFieldSave(settingsSaves, approvalSaveKey(target))
  const scoped = !!workspaceId && s.projectApprovalLevels[workspaceId] !== undefined
  const label = APPROVAL_TEXT.chip(effective, scoped)
  useCycleApprovalMode(() => change.choose(target, nextApprovalLevel(shown)))
  return (
    <span className="act-picker approval-chip" data-mode={effective}>
      <DropdownMenu.Root modal={false}>
        <IconTooltip label={APPROVAL_TEXT.tooltip(effective, scoped)}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="act-trigger approval-chip__trigger" aria-label={label} aria-busy={save?.status === 'saving'}>
              <span className={`codicon codicon-${MODE_ICON[effective]}`} aria-hidden="true" />
              <span className="act-trigger__label approval-chip__label">{APPROVAL_LEVEL_TEXT[effective].label}</span>
            </button>
          </DropdownMenu.Trigger>
        </IconTooltip>
        <DropdownMenu.Portal container={portalContainer()}>
          <DropdownMenu.Content className="act-menu" side="top" align="start" sideOffset={4}>
            {workspaceId && (
              <>
                <DropdownMenu.Label className="act-menu__note">Applies to</DropdownMenu.Label>
                <DropdownMenu.RadioGroup value={scope} onValueChange={(v) => setScope(v as 'workspace' | 'global')}>
                  <Radio value="workspace" label={APPROVAL_TEXT.scopeProject} keepOpen />
                  <Radio value="global" label={APPROVAL_TEXT.scopeAll} keepOpen />
                </DropdownMenu.RadioGroup>
                <DropdownMenu.Separator className="act-menu__separator" />
              </>
            )}
            <DropdownMenu.Label className="act-menu__note">Mode</DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={shown} onValueChange={(v) => change.choose(target, v as ApprovalLevel)}>
              {MODE_ORDER.map((m) => <Radio key={m} value={m} label={APPROVAL_LEVEL_TEXT[m].label} />)}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <FieldSaveStatus save={save} />
      <StaleLine n={change.stale} />
      <DangerConfirm change={change} />
    </span>
  )
}

function Radio({ value, label, keepOpen }: { value: string; label: string; keepOpen?: boolean }): React.JSX.Element {
  return (
    <DropdownMenu.RadioItem value={value} className="act-menu__item act-menu__item--radio" onSelect={keepOpen ? (e) => e.preventDefault() : undefined}>
      <DropdownMenu.ItemIndicator className="act-menu__check"><span className="codicon codicon-check" aria-hidden="true" /></DropdownMenu.ItemIndicator>
      {label}
    </DropdownMenu.RadioItem>
  )
}
