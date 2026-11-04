// Unforgeable mark of verifier-produced evidence (F4-c). The `verifiedBy` string alone can be typed
// by anyone holding a reference to the orchestrator port; a WeakSet entry can only be added by the
// code that imports `sealEvidence`, which is the verifier path (`toModelEvidence`). Evidence that
// round-trips through JSON (HTTP body, ledger row) loses the mark, so it can never verify a task.
const sealed = new WeakSet<object>()

/** Marks `evidence` as produced by the server verifier; returns the same object. */
export function sealEvidence<T extends object>(evidence: T): T {
  sealed.add(evidence)
  return evidence
}

/** True only for an object passed through `sealEvidence` in this process. */
export function isSealedEvidence(evidence: unknown): boolean {
  return typeof evidence === 'object' && evidence !== null && sealed.has(evidence)
}
