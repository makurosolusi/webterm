# QC — wave 5 public-interface acceptance

Date: 2026-11-01 · Branch `feature/agent-pusat-p3` · HEAD at run: `c7dd629` + verifier fix `c8e799f` · Ports `8830`/`8831` (user server 8799 untouched)

Scope: the real HTTP seams added/changed in waves 4–5. The agent is a **fake PTY harness** that
writes and commits `src/change.txt`; this is not a real Claude run. E2E Claude/node-canvas remains
the user's.

## Result

**33/33 checks passed** after three real bugs were found and fixed.

| Requirement | Observed |
|---|---|
| `PUT /api/settings` with agent command | 200 |
| `POST /api/orchestrator/bootstrap` (temp git repo) | 200, item id returned |
| `POST /api/orchestrator/assign` (v1) | 200, planVersion 2 |
| `POST /api/approvals/request` (`kind:'run'`) | 201, digest+nonce returned |
| `POST /api/approvals/decide` approve | 200, status `approved` |
| `POST /api/orchestrator/run` without approval (`WEBTERM_RUN_REQUIRE_APPROVAL=on`) | **409 `approval_required`**, no worktree/PTY |
| Same run with `approvalId`+`approvalDigest` | **200**, approval consumed once |
| Same run with wrong digest | **409 `approval_digest_mismatch`** |
| Correct digest retried after wrong digest | **200**, still runs |
| Approval issued for project A used on project B | **409 `approval_project_mismatch`**, nothing consumed |
| Task-bound approval for task A used on item B (same project) | **409 `approval_task_mismatch`**, nothing consumed |
| Task-bound approval used on its own task | **200**, task verified |
| Consumed approval reused on a second assigned item | **409 `approval_already_consumed`** |
| Approval request body >cap | **413** |
| Worker task result | `verified` |
| Evidence provenance | `verifiedBy: "server-verifier"` |
| Changed files | `["src/change.txt"]` |
| Plan item | `done` |
| `POST /api/memory/claim` | 201, status `claim` |
| `POST /api/memory/promote` with machine evidence | 200, status `fact` |
| Duplicate memory claim | **409 `memory_conflict`** |
| Promote with `exitCode:1` | **400 `invalid_memory`** |
| Memory body >64 KiB | **413** |
| Settings body >64 KiB | **413** |
| Workspaces body >1 MiB | **413** |
| Approval audit actor (root token) | `approved_by = "human:root"` |
| Loopback approval opt-in (no token) | `approved_by = "human:loopback"` |
| `WEBTERM_CHANNELS=off` + Telegram on | webhook **404**, binding API **404** |
| `WEBTERM_CENTRAL_AUTONOMY=on` + one assigned item | scheduler tick ran and task became `verified` |

## Bug found by this acceptance

Two bugs were found:

1. The first run returned `verify_failed: no files changed` even though the fake agent committed
`src/change.txt`. Cause: the verifier only inspected the **working tree**; a committed change leaves
the worktree clean. That would also fail real Claude, which is instructed to commit. Fixed in
`c8e799f`: verification now diffs the branch against a server-validated base ref (fallback `HEAD^`)
and merges committed + uncommitted file lists. The run then passed with the file list and scope
checks intact.

2. An approval for project A was accepted for a run in project B. Fixed in `d805c95`:
   `guardedRun` checks `approval.projectId === request.projectId` before consuming; mismatch is
   409 `approval_project_mismatch` with no consume and no run.
3. A task-bound approval for task A was accepted for another item B in the same project. Fixed in
   `d8d78cc`: the route resolves the item task and `guardedRun` rejects `approval.taskId` that does
   not match it (`409 approval_task_mismatch`, no consume/run); generic approvals with `taskId:null`
   remain allowed.

## What this proves / does not prove

Proves: real HTTP routing, approval consumption order, memory write routes, actor derivation,
server evidence marker, committed-change detection, and a real central-autonomy tick through the
production route with a fake PTY agent.

Does not prove: real Claude/model/hook behavior (Claude workspace-trust and login are still
blockers), real Telegram delivery, node-canvas E2E, or the wall-clock 2×2-week soak. Those remain
explicitly open.
