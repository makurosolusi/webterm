// Konfigurasi Telegram di tab Channels: entri registry `owner:'channels'` dirender dengan komponen Env yang
// sama (EnvGroupSection/EnvEntryRow) dan disimpan lewat save bar yang sama. Token write-only (EnvSecretField).
import { useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { EnvGroupSection } from './EnvGroupSection'
import { EnvRestartBanner } from './EnvRestartBanner'
import { EnvSaveBar } from './EnvSaveBar'
import { OpenEnvContext } from './channelsOpenEnv'
import { CH } from './channelsLabels'
import { partitionEntries } from './envDraft'
import { SettingsMessage } from './SettingsMessage'
import { ENV_UI } from './envSectionLabels'
import {
  EnvSettingsProvider, useEnvLoadOnMount, useEnvSettingsContext, useHasEnvSettingsContext,
} from './useEnvSettings'
import './settings-env.css'

interface Props {
  /** Kunci yang difokuskan setelah state termuat (lompat dari tab Environment). */
  focusKey?: string
  /** Dipanggil sekali setelah `focusKey` ditangani, supaya pemanggil membersihkan permintaan lompat. */
  onFocused?: () => void
}

const OWNER_CHANNELS = 'channels'
const FOCUSABLE = 'input,select,textarea,button,[role="switch"]'
const ALL_VISIBLE = (): boolean => true

/** Konfigurasi Telegram; memakai provider dari atas bila ada, kalau tidak memasang sendiri. */
export function ChannelsTelegramConfig(props: Props): React.JSX.Element {
  const panel = <TelegramPanel {...props} />
  return useHasEnvSettingsContext() ? panel : <EnvSettingsProvider query="">{panel}</EnvSettingsProvider>
}

function TelegramPanel({ focusKey, onFocused }: Props): React.JSX.Element {
  const api = useEnvSettingsContext()
  useEnvLoadOnMount()
  const openEnv = useContext(OpenEnvContext)
  const root = useRef<HTMLDivElement>(null)
  const state = api.state
  const sections = useMemo(() => {
    if (!state) return []
    const own = state.entries.filter((e) => e.owner === OWNER_CHANNELS)
    const part = partitionEntries(own, state.groups, false)
    // Satu section "Telegram" untuk kunci user dan lanjutan; dua section sejudul akan berebut key React.
    const entries = [...part.main, ...part.advanced].flatMap((s) => s.entries)
    return entries.length > 0 ? [{ title: CH.configTitle, entries }] : []
  }, [state])

  const focus = useCallback((key: string): boolean => {
    const el = [...(root.current?.querySelectorAll<HTMLElement>('[data-env-item]') ?? [])].find((n) => n.dataset.envItem === key)
    if (!el) return false
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
    el.scrollIntoView?.({ block: 'center' })
    el.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    return true
  }, [])

  // Kunci milik Channels fokus lokal; prasyarat milik Environment (LEDGER, CENTRAL, ...) pindah tab.
  const jump = useCallback((key: string): void => {
    if (focus(key)) return
    if (state?.entries.some((e) => e.key === key && e.owner !== OWNER_CHANNELS)) openEnv?.(key)
  }, [focus, state, openEnv])

  useEffect(() => {
    if (!focusKey || sections.length === 0) return
    focus(focusKey)
    onFocused?.()
  }, [focusKey, sections, focus, onFocused])

  return (
    <div className="st-ch-config" ref={root} aria-busy={api.loading}>
      <h3 className="st-ch-heading">{CH.configHeading}</h3>
      {api.error ? <SettingsMessage kind="error" role="alert">{api.error}</SettingsMessage> : null}
      {state?.locked ? <SettingsMessage kind="warning" role="status">{ENV_UI.lockedBanner}</SettingsMessage> : null}
      <EnvRestartBanner />
      {sections.length > 0 ? (
        <EnvGroupSection title={CH.configTitle} sections={sections} defaultOpen visible={ALL_VISIBLE}
          narrowed={false} onJump={jump} />
      ) : null}
      <EnvSaveBar />
    </div>
  )
}
