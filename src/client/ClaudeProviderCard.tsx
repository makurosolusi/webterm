// "Claude provider" card (Settings > Capabilities): which credential every Claude process webterm
// starts uses (agent nodes, Central, headless helpers). Server: claudeProvider/claudeProvider.api.ts.
// The key is write-only: the server answers "set" or not, the typed value lives in component state
// until Save and is cleared right after; it is never logged or put in an error message.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ClaudeLaunchProfile } from '../shared/claudeLaunch/claudeLaunch.profiles'
import { ClaudeProviderCommand } from './ClaudeProviderCommand'
import { PROVIDER_PATH as PATH, RESET_PATH, providerCall as call, type Credential, type Mode, type State, type TestResult } from './claudeProvider.api'

const MODE_LIST: Mode[] = ['login', 'apiKey', 'custom', 'command']
const CREDENTIAL_LIST: Credential[] = ['authToken', 'apiKey']

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
  credential: 'Credential type',
  credentials: { authToken: 'Auth token (Authorization: Bearer)', apiKey: 'API key (x-api-key)' } as Record<Credential, string>,
  key: 'Key or token',
  keySet: 'Saved. Type a new one to replace it.',
  keyUnset: 'Not set',
  removeKey: 'Remove key',
  model: 'Default model (optional)',
  save: 'Save',
  saved: 'Saved.',
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

/** The Claude provider card; loads from the server and waits for it on every change. */
export function ClaudeProviderCard({ onProfiles }: { onProfiles?(profiles: ClaudeLaunchProfile[]): void } = {}): React.JSX.Element {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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

  /** true = saved (or nothing to save). */
  const save = async (secretOverride?: '', profileId?: string): Promise<boolean> => {
    setBusy(true); setError(null); setNotice(null)
    const s = secretOverride ?? (secret.trim() === '' ? undefined : secret)
    try {
      adopt(await call(PATH, 'PUT', mode === 'command' ? { mode, profileId }
        : { mode, baseUrl, credential, model, ...(s === undefined ? {} : { secret: s }) }) as unknown as State)
      setSecret('')
      setNotice(PROVIDER_TEXT.saved)
      return true
    } catch (e) {
      setError(PROVIDER_TEXT.saveFailed(e instanceof Error ? e.message : 'error'))
      return false
    } finally { setBusy(false) }
  }
  const [resetting, setResetting] = useState(false)
  const reset = async (): Promise<void> => {
    setBusy(true); setResetting(true); setError(null); setNotice(null)
    try {
      adopt(await call(RESET_PATH, 'POST') as unknown as State)
      setNotice(PROVIDER_TEXT.saved)
    } catch (e) {
      setError(PROVIDER_TEXT.resetFailed(e instanceof Error ? e.message : 'error'))
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
    } finally { setBusy(false); setTesting(false) }
  }
  const test = async (): Promise<void> => {
    if (dirty && !(await save())) return
    await runTest()
  }

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
            <ClaudeProviderCommand provider={p} busy={busy} testing={testing} commit={(id) => save(undefined, id)} test={runTest} onProfiles={onProfiles} />
          ) : null}
          {mode === 'custom' ? (
            <>
              <Input aria-label={PROVIDER_TEXT.baseUrl} placeholder="https://llm-gateway.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              <Choice label={PROVIDER_TEXT.credential} options={CREDENTIAL_LIST} names={PROVIDER_TEXT.credentials} value={credential} onChange={setCredential} />
            </>
          ) : null}
          {mode !== 'login' && mode !== 'command' ? (
            <>
              <Input aria-label={PROVIDER_TEXT.key} type="password" autoComplete="off" value={secret}
                placeholder={p?.secretSet ? PROVIDER_TEXT.keySet : PROVIDER_TEXT.keyUnset} onChange={(e) => setSecret(e.target.value)} />
              <Input aria-label={PROVIDER_TEXT.model} value={model} onChange={(e) => setModel(e.target.value)} />
            </>
          ) : null}
          {mode !== 'command' ? <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void save()}>{PROVIDER_TEXT.save}</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void test()}>{testing ? PROVIDER_TEXT.testing : PROVIDER_TEXT.test}</Button>
            {mode !== 'login' && p?.secretSet ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void save('')}>{PROVIDER_TEXT.removeKey}</Button> : null}
          </div> : null}
          {testing ? <p role="status" className="text-xs opacity-70">{PROVIDER_TEXT.testing}</p> : null}
          {!testing && state.lastTest ? (
            <p role="status" className={state.lastTest.ok ? 'text-xs' : 'text-xs text-destructive'}>
              <span className={`codicon ${state.lastTest.ok ? 'codicon-pass' : 'codicon-error'}`} aria-hidden="true" /> {state.lastTest.message}
            </p>
          ) : null}
          {notice ? <p role="status" className="text-xs">{notice} {state.restartNeeded > 0 ? PROVIDER_TEXT.restart(state.restartNeeded) : PROVIDER_TEXT.newOnly}</p> : null}
          {!notice && state.restartNeeded > 0 ? <p className="text-xs opacity-70">{PROVIDER_TEXT.restart(state.restartNeeded)}</p> : null}
        </>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
