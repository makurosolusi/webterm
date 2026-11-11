// Boot decision of the desktop UI: a signed-out browser renders only SignInScreen, so App's hooks
// (settings, closed history, presence, the board) never fire a request the server would refuse.
// App keeps its own 403 fallback for a session that dies while the page is open.
import SignInScreen from './SignInScreen'
import { exchangeLandingToken, fetchMe } from './transportToken'

export type BootView = 'app' | 'sign-in'

/**
 * Trade a `?token=` landing link for the cookie (only while no account exists), then ask GET /auth/me
 * which view to render. A session without an account (setup pending) still gets the sign-in page,
 * where it creates the first account.
 */
export async function bootView(): Promise<BootView> {
  await exchangeLandingToken()
  try {
    const me = await fetchMe()
    return me.signedIn && !me.setupRequired ? 'app' : 'sign-in'
  } catch (error) {
    // Unreachable server: SignInScreen shows that state and keeps polling until it can sign in.
    console.warn('[webterm] checking the UI session at boot failed', error)
    return 'sign-in'
  }
}

/** The signed-out page: the same shell App uses when a request is refused later. */
export function SignedOut(): React.JSX.Element {
  return <div className="app-shell app-shell--auth"><SignInScreen /></div>
}
