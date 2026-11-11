// "Claude provider" card (Settings > Capabilities): which credential every Claude process webterm
// starts uses (agent nodes, Central, headless helpers). Server: claudeProvider/claudeProvider.api.ts.
// The key is write-only: the server answers "set" or not, the typed value lives in component state
// until Save and is cleared right after; it is never logged or put in an error message.
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ClaudeLaunchProfile } from '../shared/claudeLaunch/claudeLaunch.profiles'
import { ClaudeProviderCommand } from './ClaudeProviderCommand'
import { VscodeNotification, type VscodeNotificationSeverity } from './components/vscode/vscodeNotification'
import { PROJECT_MODEL_ALIASES } from '../shared/settings.projectModels'
import { SettingsCombobox } from './SettingsCombobox'
import { PROVIDER_PATH as PATH, RESET_PATH, providerCall as call, type Credential, type Mode, type State, type TestResult } from './claudeProvider.api'

const MODE_LIST: Mode[] = ['login', 'apiKey', 'custom', 'command']
const CREDENTIAL_LIST: Credential[] = ['authToken', 'apiKey']
const MODEL_PRESETS = [{ value: '', label: 'Claude Code default' }, ...PROJECT_MODEL_ALIASES.map((m) => ({ value: m }))]

/** A gateway URL: http(s), and never with a user or password in it (it would be stored and remembered). */
export function validateGatewayUrl(v: string): string | null {
  if (!v) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return PROVIDER_TEXT.badUrl
    return u.username || u.password ? PROVIDER_TEXT.urlCredentials : null
  } catch {
    return PROVIDER_TEXT.badUrl
  }
}

/** One-of-N choice as a row of shadcn buttons (aria-pressed), no raw form controls. */
function Choice<T extends string>(p: { label: string; options: T[]; names: Record<T, string>; value: T; onChange(v: T): void }): React.JSX.Element {
  return (
    <div role="group" aria-label={p.label} className="flex flex-wrap gap-1">
      {p.options.map((o) => (
        <Button key={o} size="sm" variant={p.value === o ? 'default' : 'outline'} aria-pressed={p.value === o} onClick={() => p.onChange(o)}>{p.names[o]}</Button>
      ))}
    </div>
  )
}

export const PROVIDER_TEXT = {
  title: 'Claude provider',
  why: 'Used by every Claude agent node, Central and the background helpers (classifier, planner, summaries, names).',
  modes: { login: 'Claude Code login', apiKey: 'Anthropic API key', custom: 'Custom endpoint', command: 'Custom command' } as Record<Mode, string>,
  modeHelp: {
    login: 'Default. Claude uses the account you logged in with (claude auth login). No key is stored.',
    apiKey: 'Billed per token to the Console account of the key. Claude Code asks once in each new agent node whether to use it.',
    custom: 'An Anthropic-compatible proxy or gateway (ANTHROPIC_BASE_URL) with its own key or token.',
    command: 'Claude runs through your own command, e.g. envman -e claude:my-key -- claude, which supplies its credential.',
  } as Record<Mode, string>,
  baseUrl: 'Base URL',
  badUrl: 'Enter a web address starting with https:// or http://.',
  urlCredentials: 'Leave the user and password out of the address; put the key in Key or token.',
  credential: 'Credential type',
  credentials: { authToken: 'Auth token (Authorization: Bearer)', apiKey: 'API key (x-api-key)' } as Record<Credential, string>,
  key: 'Key or token',
  keySet: 'Saved. Type a new one to replace it.',
  keyUnset: 'Not set',
  removeKey: 'Remove key',
  model: 'Default model (optional)',
  save: 'Save',
  saving: 'Saving…',
  clean: 'Saved',
  noChanges: 'No changes to save',
  saved: '✓ Saved',
  savedAt: (at: string): string => `at ${at}.`,
  savedToast: 'Claude provider saved',
  savedCheckFailed: 'Saved, but the check failed — new sessions will fail until this is fixed.',
  test: 'Test connection',
  testing: 'Testing…',
  loading: 'Loading…',
  loadFailed: 'Could not load the Claude provider.',
  saveFailed: (code: string): string => `Could not save (${code}).`,
  restart: (n: number): string => `New Claude sessions use this provider. ${n} running Claude session${n === 1 ? '' : 's'} keep${n === 1 ? 's' : ''} the previous one until restarted.`,
  newOnly: 'New Claude sessions use this provider; running ones keep theirs until restarted.',
  damaged: 'The saved Claude provider settings are damaged, so Claude starts with the Claude Code login. Reset them, or choose a provider and Save. A copy of the damaged file is kept as CONFIG_BAK.',
  reset: 'Reset to Claude Code login',
  resetting: 'Resetting…',
  resetFailed: (code: string): string => `Could not reset (${code}). Try again.`,
}

/** Saves the pending edits (resolves true when saved or nothing to save); filled in by the card. */
export type ProviderCommitRef = MutableRefObject<(() => Promise<boolean>) | null>

/** The Claude provider card; loads from the server and waits for it on every change. `onTested`: the host
 *  shows the result itself (setup wizard's live check), so the card hides its own and reports each test.
 *  `commitRef`: the host saves through it (wizard Continue), so the card hides its own Save. */
export function ClaudeProviderCard({ onProfiles, onTested, commitRef }: { onProfiles?(profiles: ClaudeLaunchProfile[]): void; onTested?(): void; commitRef?: ProviderCommitRef } = {}): React.JSX.Element {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Each save gets a new seq: the status line and the toast remount, so a repeated save is visibly new.
  const [saved, setSaved] = useState<{ seq: number; at: string } | null>(null)
  const [toast, setToast] = useState<{ seq: number; severity: VscodeNotificationSeverity; title: string } | null>(null)
  const seq = useRef(0)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [mode, setMode] = useState<Mode>('login')
  const [baseUrl, setBaseUrl] = useState('')
  const [credential, setCredential] = useState<Credential>('authToken')
  const [model, setModel] = useState('')
  const [secret, setSecret] = useState('')

  const adopt = (s: State): void => {
    // Boundary check: an answer without a provider object (old server, proxy page) is a load failure.
    if (!s.provider || typeof s.provider.mode !== 'string') throw new Error('bad_response')
    setState(s)
    setMode(s.provider.mode)
    setBaseUrl(s.provider.baseUrl ?? '')
    setCredential(s.provider.credential ?? 'authToken')
    setModel(s.provider.model ?? '')
  }
  useEffect(() => {
    call(PATH, 'GET').then((s) => adopt(s as unknown as State)).catch(() => setError(PROVIDER_TEXT.loadFailed))
  }, [])

  const markSaved = (): void => {
    const n = ++seq.current
    setSaved({ seq: n, at: new Date().toLocaleTimeString() })
    setToast({ seq: n, severity: 'info', title: PROVIDER_TEXT.savedToast })
  }
  const fail = (message: string): void => {
    setError(message)
    setToast({ seq: ++seq.current, severity: 'error', title: message })
  }
  /** true = saved. */
  const save = async (secretOverride?: '', profileId?: string): Promise<boolean> => {
    setBusy(true); setSaving(true); setError(null); setSaved(null)
    const s = secretOverride ?? (secret.trim() === '' ? undefined : secret)
    try {
      adopt(await call(PATH, 'PUT', mode === 'command' ? { mode, profileId }
        : { mode, baseUrl, credential, model, ...(s === undefined ? {} : { secret: s }) }) as unknown as State)
      setSecret('')
      markSaved()
      return true
    } catch (e) {
      fail(PROVIDER_TEXT.saveFailed(e instanceof Error ? e.message : 'error'))
      return false
    } finally { setBusy(false); setSaving(false) }
  }
  const [resetting, setResetting] = useState(false)
  const reset = async (): Promise<void> => {
    setBusy(true); setResetting(true); setError(null); setSaved(null)
    try {
      adopt(await call(RESET_PATH, 'POST') as unknown as State)
      markSaved()
    } catch (e) {
      fail(PROVIDER_TEXT.resetFailed(e instanceof Error ? e.message : 'error'))
    } finally { setBusy(false); setResetting(false) }
  }
  const p = state?.provider
  const dirty = !!p && (mode !== p.mode || secret !== '' || model !== (p.model ?? '')
    || (mode === 'custom' && (baseUrl !== (p.baseUrl ?? '') || credential !== (p.credential ?? 'authToken'))))
  // The server tests the SAVED provider, so unsaved edits are saved first: the result matches the form.
  const runTest = async (): Promise<void> => {
    setBusy(true); setTesting(true); setError(null)
    try {
      const r = (await call(`${PATH}/test`, 'POST')).test as TestResult
      setState((prev) => (prev ? { ...prev, lastTest: r } : prev))
    } catch (e) {
      setError(PROVIDER_TEXT.saveFailed(e instanceof Error ? e.message : 'error'))
    } finally { setBusy(false); setTesting(false); onTested?.() }
  }
  const test = async (): Promise<void> => {
    if (dirty && !(await save())) return
    await runTest()
  }
  // Command mode keeps its draft in ClaudeProviderCommand, which fills this with its own save (null = clean).
  const commandCommit = useRef<(() => Promise<boolean>) | null>(null)
  useEffect(() => {
    if (!commitRef) return
    commitRef.current = async () => mode === 'command' ? (commandCommit.current ? commandCommit.current() : true) : !dirty || save()
  })

  return (
    <section aria-label={PROVIDER_TEXT.title} className="flex flex-col gap-2">
      <h3>{PROVIDER_TEXT.title}</h3>
      <p className="text-xs opacity-70">{PROVIDER_TEXT.why}</p>
      {state === null && error === null ? <p role="status" className="text-xs opacity-70">{PROVIDER_TEXT.loading}</p> : null}
      {p?.configError ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded border border-[var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground))] bg-[var(--vscode-inputValidation-errorBackground)] p-2 text-xs">
          <p><span className="codicon codicon-warning" aria-hidden="true" /> {PROVIDER_TEXT.damaged}</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void reset()}>{resetting ? PROVIDER_TEXT.resetting : PROVIDER_TEXT.reset}</Button>
        </div>
      ) : null}
      {state ? (
        <>
          <Choice label={PROVIDER_TEXT.title} options={MODE_LIST} names={PROVIDER_TEXT.modes} value={mode} onChange={setMode} />
          <p className="text-xs opacity-70">{PROVIDER_TEXT.modeHelp[mode]}</p>
          {mode === 'command' && p ? (
            <ClaudeProviderCommand provider={p} busy={busy} testing={testing} commit={(id) => save(undefined, id)} test={runTest} onProfiles={onProfiles}
              onError={(m) => setToast({ seq: ++seq.current, severity: 'error', title: m })} pending={commandCommit} hideSave={!!commitRef} />
          ) : null}
          {mode === 'custom' ? (
            <>
              <SettingsCombobox ariaLabel={PROVIDER_TEXT.baseUrl} fieldId="claude.gatewayUrl" mono presets={[]} placeholder="https://llm-gateway.example.com"
                value={baseUrl} validate={validateGatewayUrl} onDraft={setBaseUrl} onCommit={setBaseUrl} />
              <Choice label={PROVIDER_TEXT.credential} options={CREDENTIAL_LIST} names={PROVIDER_TEXT.credentials} value={credential} onChange={setCredential} />
            </>
          ) : null}
          {mode !== 'login' && mode !== 'command' ? (
            <>
              <Input aria-label={PROVIDER_TEXT.key} type="password" autoComplete="off" value={secret}
                placeholder={p?.secretSet ? PROVIDER_TEXT.keySet : PROVIDER_TEXT.keyUnset} onChange={(e) => setSecret(e.target.value)} />
              <SettingsCombobox ariaLabel={PROVIDER_TEXT.model} fieldId="claude.providerModel" presets={MODEL_PRESETS}
                value={model} onDraft={setModel} onCommit={setModel} />
            </>
          ) : null}
          {mode !== 'command' ? <div className="flex items-center gap-2">
            {commitRef ? null : <Button size="sm" disabled={busy || !dirty} aria-busy={saving} title={!dirty && !saving ? PROVIDER_TEXT.noChanges : undefined}
              onClick={() => void save()}>{saving ? PROVIDER_TEXT.saving : dirty ? PROVIDER_TEXT.save : PROVIDER_TEXT.clean}</Button>}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void test()}>{testing ? PROVIDER_TEXT.testing : PROVIDER_TEXT.test}</Button>
            {mode !== 'login' && p?.secretSet ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void save('')}>{PROVIDER_TEXT.removeKey}</Button> : null}
          </div> : null}
          {testing ? <p role="status" className="text-xs opacity-70">{PROVIDER_TEXT.testing}</p> : null}
          {!testing && state.lastTest && !onTested ? (
            <p role="status" className={state.lastTest.ok ? 'text-xs' : 'text-xs text-destructive'}>
              <span className={`codicon ${state.lastTest.ok ? 'codicon-pass' : 'codicon-error'}`} aria-hidden="true" /> {state.lastTest.message}
            </p>
          ) : null}
          {/* Save clears the server's lastTest, so a failed one here is a test of what was just saved. */}
          {saved && state.lastTest?.ok === false ? <p key={saved.seq} role="status" className="text-xs text-(--vscode-editorWarning-foreground)">
            <span className="codicon codicon-warning" aria-hidden="true" /> {PROVIDER_TEXT.savedCheckFailed}</p>
          : saved ? <p key={saved.seq} role="status" className="text-xs">{PROVIDER_TEXT.saved} {PROVIDER_TEXT.savedAt(saved.at)} {state.restartNeeded > 0 ? PROVIDER_TEXT.restart(state.restartNeeded) : PROVIDER_TEXT.newOnly}</p> : null}
          {!saved && state.restartNeeded > 0 ? <p className="text-xs opacity-70">{PROVIDER_TEXT.restart(state.restartNeeded)}</p> : null}
        </>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {toast ? <VscodeNotification key={toast.seq} id={`claude-provider-${toast.seq}`} severity={toast.severity} title={toast.title}
        onClose={() => setToast((t) => (t?.seq === toast.seq ? null : t))} /> : null}
    </section>
  )
}
