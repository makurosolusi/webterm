// Policy for the human approval surface. Kept dependency-free so it is testable in node-env:
// approvalHumanApi imports bun:sqlite through the ledger runtime.
export interface ApprovalAuthEnv {
  WEBTERM_TOKEN?: string
  WEBTERM_ALLOW_LOOPBACK_APPROVAL?: string
}

/**
 * Human approval must never be token-free by default: a same-uid agent shell can curl loopback.
 * `WEBTERM_ALLOW_LOOPBACK_APPROVAL=1` is an explicit, disposable-local-demo opt-in.
 */
export function approvalAuthAllowed(env: ApprovalAuthEnv = process.env): boolean {
  const token = (env.WEBTERM_TOKEN ?? '').trim()
  if (token !== '') return true
  return env.WEBTERM_ALLOW_LOOPBACK_APPROVAL === '1'
}
