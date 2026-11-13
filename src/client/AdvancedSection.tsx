// Settings › Features › Advanced: where Chromium is (+ download it), and Reset capabilities (asks first,
// then busy, then the result with its time). Closed by default; the Browser card's step opens it. Looks like
// SettingsAdvanced (chevron, inset card) but is controlled, so the step can open it.
import { useState } from 'react'
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ActionResult, useAction } from '@/components/ui/action'
import { Button } from '@/components/ui/button'
import { ADVANCED_TEXT } from './advancedLabels'
import { callCapabilities } from './capabilitiesApi'
import { ChromiumDownload } from './ChromiumDownload'
import { ChromiumPathField } from './ChromiumPathField'
import { capabilityErrorMessage } from './useCapabilities'

type Advanced = CapabilitiesResponse['advanced']

export interface AdvancedSectionProps {
  advanced: Advanced
  /** Called after the server took a change, so the cards reload. */
  onChanged(): Promise<unknown>
  /** Open or not; the parent controls it so the Browser card's step button can open it. */
  open: boolean
  onOpenChange(open: boolean): void
}

/** The Advanced part: Chromium location (+ download Chromium) and reset. */
export function AdvancedSection({ advanced, onChanged, open, onOpenChange }: AdvancedSectionProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  const run = async (suffix: string, method: string, body: unknown): Promise<void> => {
    try {
      await callCapabilities(suffix, method, body)
      setError(null)
      await onChanged()
    } catch (e) {
      setError(capabilityErrorMessage(e, ADVANCED_TEXT.changeFailed))
    }
  }
  const reset = useAction(async () => {
    try {
      await callCapabilities('/reset', 'POST', {})
    } catch (e) {
      throw new Error(capabilityErrorMessage(e, ADVANCED_TEXT.changeFailed), { cause: e })
    }
    await onChanged()
  }, { label: ADVANCED_TEXT.reset, success: () => ADVANCED_TEXT.resetDone, failure: (e) => (e instanceof Error ? e.message : ADVANCED_TEXT.changeFailed) })
  const confirmReset = (): void => {
    setAsking(false)
    void reset.run()
  }

  return (
    <details className="st-advanced" data-slot="settings-advanced" open={open} onToggle={(e) => onOpenChange(e.currentTarget.open)}>
      <summary className="st-advanced-summary">
        <span className="codicon codicon-chevron-right st-advanced-chevron" aria-hidden="true" />
        {ADVANCED_TEXT.summary}
      </summary>
      <div className="st-group-card">
        <div className="st-form">
          <ChromiumPathField chromium={advanced.chromiumPath}
            save={(chromiumPath) => run('/advanced', 'PUT', { chromiumPath })} redetect={onChanged} />
        </div>
        {advanced.chromiumDownload?.supported ? <div className="st-form"><ChromiumDownload onDone={onChanged} /></div> : null}
        <div className="st-field">
          <div className="st-field-text">
            <span className="st-label">{ADVANCED_TEXT.reset}</span>
            <p className="st-hint">{ADVANCED_TEXT.resetHint}</p>
            <ActionResult action={reset} />
          </div>
          <div className="st-control">
            <Button size="sm" variant="outline" disabled={reset.busy} aria-busy={reset.busy} onClick={() => setAsking(true)}>
              {reset.busy ? ADVANCED_TEXT.resetting : ADVANCED_TEXT.reset}
            </Button>
          </div>
        </div>
      </div>
      {error ? <p role="alert" className="st-state st-state--error">{error}</p> : null}
      {asking ? (
        <AlertDialog open onOpenChange={(o) => { if (!o) setAsking(false) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{ADVANCED_TEXT.resetConfirm}</AlertDialogTitle>
              <AlertDialogDescription>{ADVANCED_TEXT.resetHint}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={confirmReset}>{ADVANCED_TEXT.reset}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </details>
  )
}
