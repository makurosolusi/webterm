// TODO(env-03): hapus berkas ini setelah ENV-03 (useEnvSettings.ts menerbitkan kontrak provider c-0) merge;
// deklarasi sementara agar typecheck worktree ENV-05 hijau sebelum ENV-03 ada.
import type { ReactNode } from 'react'
import type { EnvStateV2 } from '../shared/envSettings.contract'

declare module './useEnvSettings' {
  interface EnvSettingsApi {
    state: EnvStateV2 | null
    loading: boolean
    error: string | null
    draft: ReadonlyMap<string, string>
    dirtyKeys: string[]
    setDraft(k: string, v: string): void
    discard(): void
    save(): Promise<void>
    reset(k: string): Promise<void>
    refresh(): Promise<void>
    valueOf(k: string): string | undefined
    query: string
  }
  export function useEnvSettingsContext(): EnvSettingsApi
  export function EnvSettingsProvider(props: { children: ReactNode; query: string }): React.JSX.Element
}
