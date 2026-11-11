// Settings › Rules & secrets › Advanced: the policy simulator, which replays the last 7 days of decisions against
// a proposed rule and shows what would have changed. Nothing runs while simulating. The F4-d small-model
// switches are no longer here: Settings › Claude's approval level sets them (server setClassifierSwitch).
import { useEffect, useState } from 'react'
import { ActionButton, useAction } from '@/components/ui/action'
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
  const [rule, setRule] = useState({ subject: 'node:*', capability: '', scope: '*', effect: 'allow' as SimRuleEffect })
  const [classifier, setClassifier] = useState(false)
  const [report, setReport] = useState<SimReport | null>(null)

  // "Include the small model" starts at today's switch (set by the approval level); a read failure leaves it off.
  useEffect(() => {
    let live = true
    request('GET', POLICY_CLASSIFIER_PATH)
      .then((v) => { if (live) setClassifier((v as ClassifierSwitch).central || (v as ClassifierSwitch).permissions) })
      .catch(() => {}) // ledger off or older server: the try below says so when run
    return () => { live = false }
  }, [])

  const simulate = useAction(async () => {
    const add = rule.capability.trim() ? [{ subject: rule.subject.trim(), capability: rule.capability.trim(), scope: rule.scope.trim() || '*', effect: rule.effect }] : []
    const out = (await request('POST', POLICY_SIMULATE_PATH, { add, classifier })) as SimReport
    setReport(out)
    return out
  }, { label: SIM_TEXT.run, failure: (err) => SIM_TEXT.simFailed(err instanceof Error ? err.message : String(err)) })
  const simError = simulate.result && !simulate.result.ok ? simulate.result.text : null

  return (
    <section aria-label={SIM_TEXT.simTitle} className="flex flex-col gap-2" data-testid="policy-simulator">
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
          <ActionButton size="sm" action={simulate} busyLabel={SIM_TEXT.running}>{SIM_TEXT.run}</ActionButton>
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
