// Test-only signed-in UI: importing this registers TEST_SESSION as a live `wt_ui` session with the
// pure human-only gate (approvalAuth.ts), so node-env tests can fake the webterm page without
// bun:sqlite. Bun tests that load uiSession.ts can mint real ones with `uiSessions().create()`.
import { acceptUiSessions } from './approvalAuth'
import { UI_SESSION_COOKIE } from './auth'

/** 43 base64url chars, the shape of a real session value. */
export const TEST_SESSION = 'T'.repeat(43) // test-only
export const TEST_UI_COOKIE = `${UI_SESSION_COOKIE}=${TEST_SESSION}`

acceptUiSessions((raw) => raw === TEST_SESSION)
