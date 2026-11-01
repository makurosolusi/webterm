// Dispatch keluarga `/api/control/approval/*` ke handler murni `handleApproval`. Dipisah dari
// `mount.ts` supaya file jembatan itu tetap di bawah budget; `mount.ts` hanya memanggil seam ini.
//
// Ledger mati = 503 `ledger_off` untuk SEMUA path approval (termasuk GET list), bukan 404, supaya
// klien bisa membedakan "fitur dimatikan" dari "route tidak ada". Auth capability tetap milik
// `handleApproval`: seam ini tidak membaca `x-webterm-token` sama sekali.
import type { ApprovalAcks, ApprovalLedgerPort } from './approvalApi'
import { APPROVAL_PREFIX, handleApproval } from './approvalApi'
import { AckStore, type ControlCapabilities, type ControlRequest, type ControlResult } from './controlTypes'

export const LEDGER_OFF = { status: 503, body: { error: 'ledger_off' } } as const

export interface ApprovalDispatchDeps {
  capabilities: ControlCapabilities
  /** `activeLedgerRuntime()?.ledger.approval`, atau undefined saat flag ledger mati. */
  approval: ApprovalLedgerPort | undefined
  /** Durable store derived from the active ledger db; absent = per-port in-memory `AckStore`. */
  acks?: ApprovalAcks
  now?: () => number
}

/**
 * Ack store per ledger port, passed explicitly. `handleApproval` otherwise keys its WeakMap on the
 * deps object, and production builds that object per request, so the 10-minute replay window never
 * existed (QC H2/B1). Keying on the port makes the window independent of how many deps objects the
 * caller allocates.
 */
const acksByPort = new WeakMap<ApprovalLedgerPort, AckStore>()
function acksFor(port: ApprovalLedgerPort): AckStore {
  let store = acksByPort.get(port)
  if (!store) acksByPort.set(port, (store = new AckStore()))
  return store
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
    acks: deps.acks ?? acksFor(deps.approval),
    ...(deps.now ? { now: deps.now } : {}),
  })
}
