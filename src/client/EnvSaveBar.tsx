// Bar simpan sticky: "N perubahan belum disimpan · Simpan · Buang"; konfirmasi bila ada kunci berbahaya.
// Wrapper + live region selalu terpasang agar "Tersimpan" diumumkan dan fokus punya tujuan setelah bar hilang.
import { useEffect, useRef, useState } from 'react'
import { dangerousDirtyLabels } from './envDraft'
import { ENV_UI } from './envSectionLabels'
import { useEnvSettingsContext } from './useEnvSettings'

type Phase = 'idle' | 'confirm' | 'saving'

/** Bar simpan massal untuk draft env. */
export function EnvSaveBar(): React.JSX.Element {
  const api = useEnvSettingsContext()
  const [phase, setPhase] = useState<Phase>('idle')
  const [saved, setSaved] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const confirmBtn = useRef<HTMLButtonElement>(null)
  const n = api.dirtyKeys.length
  const danger = dangerousDirtyLabels(api.state?.entries ?? [], api.dirtyKeys)

  useEffect(() => { if (n > 0) setSaved(false) }, [n])
  useEffect(() => { if (n === 0 && phase === 'confirm') setPhase('idle') }, [n, phase])
  useEffect(() => { if (phase === 'confirm') confirmBtn.current?.focus() }, [phase])

  const commit = async (): Promise<void> => {
    setPhase('saving')
    try {
      await api.save()
      setSaved(true)
      anchor.current?.focus()
    } catch {
      // Kegagalan sudah tampil lewat api.error (dirender section); draft tetap utuh untuk dicoba lagi.
    } finally {
      setPhase('idle')
    }
  }
  const discard = (): void => { api.discard(); setSaved(false); setPhase('idle'); anchor.current?.focus() }

  return (
    <div className="st-env-savebar" ref={anchor} tabIndex={-1}>
      {n > 0 ? (
        <div className="st-env-savebar-row" role="group" aria-label={ENV_UI.saveBarLabel}>
          {phase === 'confirm' ? (
            <>
              <span>{ENV_UI.confirmDangerous(danger.join(', '))}</span>
              <button type="button" ref={confirmBtn} className="st-button st-button--primary" onClick={() => void commit()}>
                {ENV_UI.confirmYes}
              </button>
              <button type="button" className="st-button" onClick={() => setPhase('idle')}>{ENV_UI.confirmNo}</button>
            </>
          ) : (
            <>
              <span>{ENV_UI.dirtyCount(n)}</span>
              <button type="button" className="st-button st-button--primary" disabled={phase === 'saving'}
                onClick={() => (danger.length > 0 ? setPhase('confirm') : void commit())}>
                {phase === 'saving' ? ENV_UI.saving : ENV_UI.save}
              </button>
              <button type="button" className="st-button" disabled={phase === 'saving'} onClick={discard}>{ENV_UI.discard}</button>
            </>
          )}
        </div>
      ) : null}
      <p className="st-note st-env-saved" role="status">{saved && n === 0 ? ENV_UI.saved : ''}</p>
    </div>
  )
}
