// Settings › Rules & approvals: the F4-d classifier switches (default off, always shown) and the policy
// simulator (collapsed), which replays the last 7 days of decisions against a proposed rule and shows what
// would have changed. Nothing runs while simulating.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Segmented } from './centralSettings.controls'
import { SettingsSelect } from './SettingsControls'
import { SettingsCombobox } from './SettingsCombobox'
import { CAPABILITY_PRESETS, SCOPE_PRESETS, SUBJECTS, whatText, whoText } from './policyPresets'

export const POLICY_CLASSIFIER_PATH = '/api/policy/classifier'
export const POLICY_SIMULATE_PATH = '/api/policy/simulate'

export interface ClassifierSwitch { central: boolean; permissions: boolean }
type SimEffect = 'allow' | 'ask' | 'deny' | 'classifier'
/** Mirror of the server `SimReport` (src/server/policy/policy.simulate.ts); only the fields rendered here. */
export interface SimReport {
  total: number; truncated: boolean; changed: number; neverAutoHeld: number
  before: Record<SimEffect, number>; after: Record<SimEffect, number>
  examples: Array<{ seq: number; ts: number; principal: string; capability: string; resource: string | null; before: SimEffect; after: SimEffect; reason: string }>
}

export const SIM_TEXT = {
  title: 'Auto-approval',
  intro: 'A small model can approve low-risk actions instead of you. Deleting things, pushing code, removing branches, using secrets, touching files outside the project and changing rules always ask you. Off until you turn it on.',
  central: 'Let a small model approve low-risk actions for Central',
  permissions: 'Let a small model approve low-risk Claude Code prompts',
  switchFailed: (why: string) => `Could not change the switch: ${why}`,
  switchMissing: 'Auto-approval is unavailable while the ledger is off.',
  simTitle: 'Try a rule on the last 7 days',
  simIntro: 'See what a rule would have changed. Nothing runs and nothing is saved.',
  subject: 'Who', capability: 'What', scope: 'Where', effect: 'Effect',
  classifierOn: 'Include the small model',
  run: 'Try it', running: 'Trying…',
  simFailed: (why: string) => `The try failed: ${why}`,
  summary: (total: number, changed: number) => `${total} decisions replayed, ${changed} would change.`,
  truncated: 'Only the newest events were replayed.',
  held: (n: number) => `${n} would still ask you: those actions always ask.`,
  colEffect: 'Outcome', colNow: 'Now', colProposed: 'With this rule',
  effect_: { allow: 'Allowed', ask: 'Asked you', deny: 'Denied', classifier: 'Sent to the small model' } as Record<SimEffect, string>,
  noChange: 'Nothing would change.',
} as const

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `${method} ${path} -> ${res.status}`)
  return out
}

const EFFECTS = [{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'deny', label: 'Deny' }] as const
type SimRuleEffect = (typeof EFFECTS)[number]['value']
const ROWS: SimEffect[] = ['allow', 'ask', 'deny', 'classifier']

export function PolicySimulator(): React.JSX.Element {
  const [sw, setSw] = useState<ClassifierSwitch | null>(null)
  const [swError, setSwError] = useState<string | null>(null)
  const [swMissing, setSwMissing] = useState(false)
  const [rule, setRule] = useState({ subject: 'node:*', capability: '', scope: '*', effect: 'allow' as SimRuleEffect })
  const [classifier, setClassifier] = useState(false)
  const [report, setReport] = useState<SimReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [simError, setSimError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    request('GET', POLICY_CLASSIFIER_PATH)
      .then((v) => { if (live) { setSw(v as ClassifierSwitch); setClassifier((v as ClassifierSwitch).central || (v as ClassifierSwitch).permissions) } })
      .catch(() => { if (live) setSwMissing(true) }) // ledger off or older server: a note, not an alert
    return () => { live = false }
  }, [])

  const flip = async (key: keyof ClassifierSwitch, on: boolean): Promise<void> => {
    if (!sw) return
    try {
      setSw((await request('PUT', POLICY_CLASSIFIER_PATH, { ...sw, [key]: on })) as ClassifierSwitch)
      setSwError(null)
    } catch (err) {
      setSwError(SIM_TEXT.switchFailed(err instanceof Error ? err.message : String(err)))
    }
  }

  const simulate = async (): Promise<void> => {
    setBusy(true)
    setSimError(null)
    try {
      const add = rule.capability.trim() ? [{ subject: rule.subject.trim(), capability: rule.capability.trim(), scope: rule.scope.trim() || '*', effect: rule.effect }] : []
      setReport((await request('POST', POLICY_SIMULATE_PATH, { add, classifier })) as SimReport)
    } catch (err) {
      setSimError(SIM_TEXT.simFailed(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label={SIM_TEXT.title} className="flex flex-col gap-2" data-testid="policy-simulator">
      <h3 className="font-semibold">{SIM_TEXT.title}</h3>
      <p className="text-xs opacity-80">{SIM_TEXT.intro}</p>
      {(['central', 'permissions'] as const).map((k) => (
        <label key={k} htmlFor={`cls-${k}`} className="flex items-center gap-2 text-xs">
          <Switch id={`cls-${k}`} disabled={!sw} checked={sw?.[k] === true} onCheckedChange={(v) => { void flip(k, v) }} />{SIM_TEXT[k]}
        </label>
      ))}
      {swMissing ? <p className="text-xs opacity-70">{SIM_TEXT.switchMissing}</p> : null}
      {swError ? <p role="alert" className="text-xs text-destructive">{swError}</p> : null}

      <details data-testid="policy-simulator-try">
        <summary className="cursor-default text-xs font-semibold">{SIM_TEXT.simTitle}</summary>
        <p className="text-xs opacity-70">{SIM_TEXT.simIntro}</p>
        <div className="flex flex-wrap items-center gap-2">
          <SettingsSelect ariaLabel={SIM_TEXT.subject} value={rule.subject} options={SUBJECTS} onChange={(v) => setRule((r) => ({ ...r, subject: v }))} />
          <span className="w-56">
            <SettingsCombobox ariaLabel={SIM_TEXT.capability} fieldId="policy.capability" mono presets={CAPABILITY_PRESETS} placeholder={SIM_TEXT.capability}
              value={rule.capability} onDraft={(v) => setRule((r) => ({ ...r, capability: v }))} onCommit={(v) => setRule((r) => ({ ...r, capability: v }))} />
          </span>
          <span className="w-40">
            <SettingsCombobox ariaLabel={SIM_TEXT.scope} fieldId="policy.scope" mono presets={SCOPE_PRESETS} placeholder={SIM_TEXT.scope}
              value={rule.scope} onDraft={(v) => setRule((r) => ({ ...r, scope: v }))} onCommit={(v) => setRule((r) => ({ ...r, scope: v }))} />
          </span>
          <Segmented label={SIM_TEXT.effect} value={rule.effect} options={EFFECTS} onChange={(v) => setRule((r) => ({ ...r, effect: v as SimRuleEffect }))} />
          <label htmlFor="sim-classifier" className="flex items-center gap-1 text-xs">
            <Switch id="sim-classifier" checked={classifier} onCheckedChange={setClassifier} />{SIM_TEXT.classifierOn}
          </label>
          <Button size="sm" disabled={busy} onClick={() => { void simulate() }}>{busy ? SIM_TEXT.running : SIM_TEXT.run}</Button>
        </div>
        {simError ? <p role="alert" className="text-xs text-destructive">{simError}</p> : null}
        {report ? (
          <div className="text-xs" role="status">
            <p>{SIM_TEXT.summary(report.total, report.changed)}{report.truncated ? ` ${SIM_TEXT.truncated}` : ''}</p>
            {report.neverAutoHeld > 0 ? <p>{SIM_TEXT.held(report.neverAutoHeld)}</p> : null}
            <table className="mt-1 border-collapse">
              <thead><tr className="text-left opacity-70"><th className="pr-4">{SIM_TEXT.colEffect}</th><th className="pr-4">{SIM_TEXT.colNow}</th><th>{SIM_TEXT.colProposed}</th></tr></thead>
              <tbody>
                {ROWS.map((e) => (
                  <tr key={e} data-effect={e}><td className="pr-4">{SIM_TEXT.effect_[e]}</td><td className="pr-4">{report.before[e]}</td><td>{report.after[e]}</td></tr>
                ))}
              </tbody>
            </table>
            {report.examples.length === 0 ? <p className="opacity-70">{SIM_TEXT.noChange}</p> : (
              <ul className="mt-1">
                {report.examples.map((x) => (
                  <li key={x.seq}>{whoText(x.principal)} → {whatText(x.capability)}{x.resource ? ` (${x.resource})` : ''}: {SIM_TEXT.effect_[x.before]} → {SIM_TEXT.effect_[x.after]}</li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </details>
    </section>
  )
}
