// The one Sign out flow of the UI (Settings › Account and the title-bar account menu): POST /auth/logout,
// reload only on success (the sign-in page then shows), and on a refusal stay and say so.
import { useCallback, useState } from 'react'
import { ACCOUNT_TEXT } from './accountLabels'
import { logout } from './transportToken'

const defaultReload = (): void => location.reload()

/** Sign out of this browser: `busy` until the reload (or the failure), `error` the sentence of a refusal. */
export function useSignOut(reload: () => void = defaultReload): { signOut: () => void; busy: boolean; error: string | null } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signOut = useCallback(() => {
    setBusy(true)
    setError(null)
    // Busy stays on after success: the page is reloading and a second click would race it.
    logout().then(reload, (e: unknown) => {
      setBusy(false)
      setError(ACCOUNT_TEXT.failed('Signing out', e instanceof Error ? e.message : String(e)))
    })
  }, [reload])
  return { signOut, busy, error }
}
