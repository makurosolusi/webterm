// Secret masking for the Diff node: both sides are masked per side by the detector, with a
// "N secrets masked · Reveal" control. Masks keep the length, so a secret that changes to another
// value of the same length would look unchanged; the notice says so and Reveal shows the truth.
import { useMemo, type ReactNode } from 'react'
import { Button as VscodeButton } from '@/vscode/register'
import { IconTooltip } from '@/components/ui/icon-button'
import { detectSecrets } from '../shared/secretMask.detect'
import type { DiffSides } from './DiffNode.editor'
import { maskText, type MaskScan } from './secretMask.reveal'
import { useSecretReveal } from './secretMask.useReveal'
import { useLiveSettings } from './useSettings'

export const DIFF_MASK_NOTICE = 'Secret values are masked; changes between equal-length masked values are not shown until revealed'

const NONE: MaskScan = { fileWide: false, ranges: [], truncated: false }
const count = (s: MaskScan): number => (s.fileWide ? 1 : s.ranges.length)

/** Masked copy of `sides` (raw when the setting is off or a side is revealed) plus the control bar. */
export function useDiffMask(raw: DiffSides | null): { sides: DiffSides | null; bar: ReactNode } {
  const { maskSecrets, maskAutoHideSec } = useLiveSettings()
  const enabled = maskSecrets && !!raw
  const before = useMemo(() => (enabled && raw ? detectSecrets(raw.path, raw.original) : NONE), [enabled, raw])
  const after = useMemo(() => (enabled && raw ? detectSecrets(raw.path, raw.modified) : NONE), [enabled, raw])
  const rb = useSecretReveal({ scan: before, autoHideSec: maskAutoHideSec, enabled })
  const ra = useSecretReveal({ scan: after, autoHideSec: maskAutoHideSec, enabled })

  const sides = useMemo(() => {
    if (!enabled || !raw) return raw
    return { path: raw.path, original: maskText(raw.original, before, rb.state), modified: maskText(raw.modified, after, ra.state) }
  }, [enabled, raw, before, after, rb.state, ra.state])

  const total = count(before) + count(after)
  const masked = rb.masked + ra.masked
  if (!enabled || total === 0) return { sides, bar: null }
  const reveal = (): void => { rb.revealAll(); ra.revealAll() }
  const hide = (): void => { rb.hideAll(); ra.hideAll() }
  const bar = (
    <div className="diff-node__mask nodrag" role="status" data-testid="diff-mask">
      {masked > 0 ? (
        <>
          <IconTooltip label="Show the secret values in this diff until you leave or the timer ends">
            <VscodeButton secondary onClick={reveal}>{`${masked} secret${masked === 1 ? '' : 's'} masked · Reveal`}</VscodeButton>
          </IconTooltip>
          <span className="diff-node__notice">{DIFF_MASK_NOTICE}</span>
        </>
      ) : (
        <IconTooltip label="Mask the secret values again">
          <VscodeButton secondary onClick={hide}>Secrets revealed · Hide</VscodeButton>
        </IconTooltip>
      )}
    </div>
  )
  return { sides, bar }
}
