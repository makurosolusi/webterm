// Dispatch keluarga `/api/control/approval/*` ke handler murni `handleApproval`. Dipisah dari
// `mount.ts` supaya file jembatan itu tetap di bawah budget; `mount.ts` hanya memanggil seam ini.
//
// Ledger mati = 503 `ledger_off` untuk SEMUA path approval (termasuk GET list), bukan 404, supaya
// klien bisa membedakan "fitur dimatikan" dari "route tidak ada". Auth capability tetap milik
// `handleApproval`: seam ini tidak membaca `x-webterm-token` sama sekali.
import type { ApprovalLedgerPort } from './approvalApi'
import { APPROVAL_PREFIX, handleApproval } from './approvalApi'
import type { ControlCapabilities, ControlRequest, ControlResult } from './controlTypes'

export const LEDGER_OFF = { status: 503, body: { error: 'ledger_off' } } as const

export interface ApprovalDispatchDeps {
  capabilities: ControlCapabilities
  /** `activeLedgerRuntime()?.ledger.approval`, atau undefined saat flag ledger mati. */
  approval: ApprovalLedgerPort | undefined
  now?: () => number
}

/** `null` = bukan route approval; pemanggil melanjutkan ke router control biasa. */
export async function approvalRoute(
  req: ControlRequest,
  deps: ApprovalDispatchDeps
): Promise<ControlResult> {
  const pathname = req.path.split('?')[0]
  if (pathname !== APPROVAL_PREFIX && !pathname.startsWith(`${APPROVAL_PREFIX}/`)) return null
  if (!deps.approval) return LEDGER_OFF
  return handleApproval(req, {
    capabilities: deps.capabilities,
    approval: deps.approval,
    ...(deps.now ? { now: deps.now } : {}),
  })
}
