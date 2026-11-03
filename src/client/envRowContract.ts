// Kontrak props baris env (c-0) antara ENV-03 (pemakai) dan ENV-04 (pembuat EnvEntryRow).
import type { ComponentType } from 'react'
import type { EnvEntryV2 } from '../shared/envSettings.contract'
import { EnvEntryRow } from './EnvEntryRow'

/** Props baris env sesuai kontrak c-0. */
export interface EnvEntryRowProps {
  entry: EnvEntryV2
  draft?: string
  onDraft(v: string): void
  onReset(): void
  get(k: string): string | undefined
  onJump(k: string): void
  locked: boolean
  rootGate: boolean
}

// TODO(env-04): hapus cast setelah merge ENV-04 — signature EnvEntryRow berubah ke kontrak c-0
/** EnvEntryRow bertipe kontrak c-0. */
export const EnvRow = EnvEntryRow as unknown as ComponentType<EnvEntryRowProps>
