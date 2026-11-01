# QC — wave 5 public-interface acceptance

Date: 2026-11-01 · Branch `feature/agent-pusat-p3` · HEAD at run: `c7dd629` + verifier fix `c8e799f` · Ports `8830`/`8831` (user server 8799 untouched)

Scope: the real HTTP seams added/changed in waves 4–5. The agent is a **fake PTY harness** that
writes and commits `src/change.txt`; this is not a real Claude run. E2E Claude/node-canvas remains
the user's.

## Result

**17/17 checks passed** after one real bug was found and fixed.

| Requirement | Observed |
|---|---|
| `PUT /api/settings` with agent command | 200 |
| `POST /api/orchestrator/bootstrap` (temp git repo) | 200, item id returned |
| `POST /api/orchestrator/assign` (v1) | 200, planVersion 2 |
| `POST /api/approvals/request` (`kind:'run'`) | 201, digest+nonce returned |
| `POST /api/approvals/decide` approve | 200, status `approved` |
| `POST /api/orchestrator/run` without approval (`WEBTERM_RUN_REQUIRE_APPROVAL=on`) | **409 `approval_required`**, no worktree/PTY |
| Same run with `approvalId`+`approvalDigest` | **200**, approval consumed once |
| Worker task result | `verified` |
| Evidence provenance | `verifiedBy: "server-verifier"` |
| Changed files | `["src/change.txt"]` |
| Plan item | `done` |
| `POST /api/memory/claim` | 201, status `claim` |
| `POST /api/memory/promote` with machine evidence | 200, status `fact` |
| Approval audit actor (root token) | `approved_by = "human:root"` |
| `WEBTERM_CENTRAL_AUTONOMY=on` + one assigned item | scheduler tick ran and task became `verified` |

## Bug found by this acceptance

The first run returned `verify_failed: no files changed` even though the fake agent committed
`src/change.txt`. Cause: the verifier only inspected the **working tree**; a committed change leaves
the worktree clean. That would also fail real Claude, which is instructed to commit. Fixed in
`c8e799f`: verification now diffs the branch against a server-validated base ref (fallback `HEAD^`)
and merges committed + uncommitted file lists. The run then passed with the file list and scope
checks intact.

## What this proves / does not prove

Proves: real HTTP routing, approval consumption order, memory write routes, actor derivation,
server evidence marker, committed-change detection, and a real central-autonomy tick through the
production route with a fake PTY agent.

Does not prove: real Claude/model/hook behavior (Claude workspace-trust and login are still
blockers), real Telegram delivery, node-canvas E2E, or the wall-clock 2×2-week soak. Those remain
explicitly open.
