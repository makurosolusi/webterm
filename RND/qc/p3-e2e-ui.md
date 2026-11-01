# P3 End-to-End UI QA (independent, ego-browser)

- Date: 2026-11-01 12:04-12:10 (+08:00)
- Branch: `feature/agent-pusat-p3` @ `c7c0eda`
- Method: real Chromium (ego-lite 0.6.1.13) via `ego-browser`, one TaskSpace (`17`) for the whole goal.
- Target: existing dev server `http://127.0.0.1:8810` (PID 67712), `WEBTERM_DATA_DIR=/tmp/webterm-p3-ui-data`, `WEBTERM_LEDGER=on`, token off (loopback only). Server was not killed or restarted.
- Constraint respected: no `src/**` edits, nothing committed. Only this report plus screenshots under `RND/qc/p3-e2e-ui-assets/` were written.
- Browser TaskSpace finished with `keep: []`.

Verdict: **workspace, filters and the approval consent gate work; three real defects remain** (task-approval consume is a no-op and hides a still-pending row; minimap is white; narrow layout clips the Inbox). Details below.

---

## 1. Workspace load, dock badge, open/close

Observed at load (1440x764):

- Tab strip: `Demo Workspace`; canvas `.react-flow` present; sessions dock shows `Sessions 0` / `No sessions yet.`.
- `GET /api/workspaces` returns one workspace with `"nodes":[]`, so the canvas legitimately has 0 nodes. Node rendering/interaction could not be exercised; canvas DOM and viewport were intact.
- Inbox panel open on boot (`webterm.inboxOpen` persisted): header `Inbox 3`, `All 3 · Needs you 1 · Review 1 · Broken 1`.
- Dock button state `aria-pressed="true"`.

Open/close matrix (all pass):

| Action | Result |
| --- | --- |
| Dock button click | panel unmounts; `aria-pressed="false"` |
| Dock button with 3 pending | `aria-label="Toggle inbox panel (3 unread)"`, badge text `3` |
| Reopen | panel visible, `aria-pressed="true"` |
| `Escape` (no dialog) | panel closes |
| `i` hotkey | panel reopens |
| `Escape` while dialog open | only dialog closes; panel stays open |

False positive checked: while the panel is open the badge is not fetched (by design in `useInboxBadge`), so **on boot the badge is absent even though 3 items exist**. It only appears after the first close. Once shown it can go stale while the panel is open (see B6).

Canvas/sessions integrity: `.react-flow__viewport` transform stayed `matrix(1, 0, 0, 1, 0, 0)` before/after every toggle, sessions dock content unchanged, no console exceptions during any toggle.

Screenshot: `p3-e2e-ui-assets/02-inbox-open.png`.

## 2. Filters

`All 3 / Needs you 1 / Review 1 / Broken 1` observed; clicking each chip produced exactly the matching section and rows:

| Chip | `aria-pressed` | Sections rendered | Rows |
| --- | --- | --- | --- |
| All | true | Needs you 1, Review 1, Broken 1 | Approval: task, review me, broken thing |
| Needs you | true | Needs you 1 | Approval: task |
| Review | true | Review 1 | review me |
| Broken | true | Broken 1 | broken thing |

Rows show state label, title, age (`2m ago`, `10m ago`), kind (`approval` / `task`), project (`p-demo`) and evidence (`{"tests":3}`, `{"reason":"test failed"}`). Pass.

## 3. Existing approval: consent gating, decide, consume

Dialog content on open (`Review` on `Approval: task`):

- Title `Approve action`; description `Approval: task`
- Facts: `Project=p-demo`, `Kind=task`, `Digest=61fb46f9260a…`, `Expiry=expires in 11:56` (live countdown)
- Buttons: Close, `Approve` **disabled**, `Reject` enabled

Gate checks:

- Approve disabled with nothing filled.
- Programmatic click on the disabled button is refused by the browser (`none can receive input; element is disabled`) and no request was issued; dialog state unchanged apart from the countdown.
- Checkbox alone: `Approve` still disabled.
- Lowercase `approve`: still disabled, hint `Type exactly APPROVE (uppercase).`
- Exact `APPROVE` + checkbox: `Approve` becomes enabled.

Decision and consume:

- `POST /api/approvals/decide` → `200`, dialog becomes `Approved action`, status `Decision recorded. Consume the approval to let the action run.`
- `POST /api/approvals/consume` → `200`, status `Consumed. The action is approved.`, button `Done`
- Panel after consume: `All 2 · Needs you 0 · Review 1 · Broken 1`; the approval row is gone. `GET /api/inbox` agrees (`needsYou:0`).

Screenshots: `p3-e2e-ui-assets/04-approval-ready.png`, `04b-approval-armed.png`, `05b-consumed.png`.

## 4. Task review flow

`Review` on `review me` (kind `task`):

- `POST /api/approvals/request` → **201** (no 404/401); dialog renders with the same facts layout.
- Decide → `200`; Consume → `200`; `GET /api/inbox` → `200`.
- Observed digest for the task challenge was the **same** `61fb46f9260a…` as the earlier approval challenge (same request payload). See B7.

Semantic gap confirmed: after consume, `GET /api/orchestrator/tasks?projectId=p-demo` still returns `t-review` with `status: "claimed_done"`, and `GET /api/inbox` still lists `t-review` as `category: "review"`. The approval is recorded and consumed but **nothing transitions the task and nothing acknowledges the review**. The UI appears clean only because it hides the row locally (B2).

Screenshots: `p3-e2e-ui-assets/06-task-review-dialog.png`, `07-task-consumed.png`, `13-after-task-consume-refresh.png`.

## 5. Minimap and console

- Computed style of the minimap element: `background-color: rgb(255, 255, 255)` while `--canvas-bg` resolves to `#000000`. Screenshot confirms a large white rectangle in the bottom-right dock.
- Element class list: `react-flow__panel react-flow__minimap minimap-dock bottom right`.
- Cause (from live styleSheets): `.minimap-dock { background: var(--canvas-bg) }` is overridden by React Flow's own `.react-flow__minimap { background: var(--xy-minimap-background-color-props, … #fff) }`. Same specificity, React Flow's rule appears later in the cascade. `styles.css` did not win, so the styles fix is **not effective on this branch/build**.

Console: `Runtime.exceptionThrown` and `Log.entryAdded(level=error)` were empty across every round (load, toggles, filters, 3 approvals, reload, narrow viewport).

Screenshots: `p3-e2e-ui-assets/15-final-workspace.png`, `15-minimap-crop.png`.

## 6. Narrow window (supported? partially)

At 620x700 via `Emulation.setDeviceMetricsOverride`:

- `document.documentElement.scrollWidth <= innerWidth` (no horizontal scrollbar), so the clipped content is not reachable by scrolling.
- Inbox panel is cut off on the left: the header reads `box 1` (not `Inbox`), the `All` chip is missing from the filter row, and the panel overlaps the Dock. Broken/Review rows still render and the Broken filter works, but the panel is not usable as a surface at this width.
- Minimap still white and overlaps the canvas bottom-right.

Screenshot: `p3-e2e-ui-assets/14-narrow.png`.

---

## Bugs

### B1 (High, P3 semantic) Task approval consume does not transition the task
Steps: open Inbox → `Review review me` → checkbox + `APPROVE` → Approve → Consume approval → Done.
Observed: `Consumed. The action is approved.`; `/api/orchestrator/tasks` still `t-review: claimed_done`; `/api/inbox` still reports `review: 1` with the same item.
Why it matters: the human "review" decision has no effect on the work item; the queue item can never clear except by expiry/expiry-like handling. This is the P3 consume→task transition gap.

### B2 (Medium) Consuming a task approval hides the still-listed task row
Steps: same as B1, then click Refresh inbox.
Observed: UI `All 1 · Review 0`, only `broken thing`; server still returns `t-review` (`total 2, review 1`). A full page reload restores the row.
Cause: `InboxPanel.consume()` adds `current.queue[index].id` to `hidden`; for `kind: "task"` that id is the task id, not an approval id. `hidden` is state-only and never cleared by refresh/poll.

### B3 (High, capability) A local agent/client can approve and consume without the human UI
Steps (curl, no token; server is loopback/token-off):
1. `POST /api/approvals/request` with `{projectId:"p-demo",kind:"task",request:{...}}` → `201`, body contains `id`, `digest`, **and `nonce`**.
2. `POST /api/approvals/decide` echoing those values with `"approve":true` → `200 {"status":"approved"}`.
3. `POST /api/approvals/consume` with `id`+`digest` → `200 {"ok":true}`.
No consent surface, checkbox or typed phrase is involved. So in this mode **an agent capability could approve** via the human route (not via the control plane). The control-plane route `/api/control/approval/*` is correctly capability-gated and ignores `x-webterm-token`; the gap is that the human route is unauthenticated on loopback and hands out its own nonce, so possession of the challenge equals approval. The UI consent gate is a UX gate, not an authorization boundary.

### B4 (Low) Minimap renders white
See section 5. Fix is a specificity/order issue (e.g. `.react-flow__minimap.minimap-dock` or set `--xy-minimap-background-color` / `maskColor` instead of `background` on the same node).

### B5 (Low/Medium) Reject leaves the row visible until manual refresh
Steps: open a `needs_you` approval → `Reject`. Dialog says `Rejected. The action will not run.`; after Close the row is still in the panel and in the counts (`Needs you 2`) until `Refresh inbox` is pressed. Consume, by contrast, removes immediately. Inconsistent queue hygiene.

### B6 (Low) Dock badge is absent on boot and stale while the panel is open
On boot with the panel open, `aria-label="Toggle inbox panel"` and no badge despite 3 items. After consuming one approval while open, badge still said `(3 unread)` while the panel and `/api/inbox` said 2. It corrects only after closing the panel (`(2 unread)`).

### B7 (Low, doc) Digest comment contradicts implementation
`src/server/ledger/ledgerApproval.ts` header says "digest of the exact action + a nonce", but `approvalDigest(input.request)` hashes only the request. Two separate challenges for the same request produced the identical digest `61fb46f9260a…`. Deterministic digests are defensible; the comment is not.

### B8 (Low) Narrow viewport clips the Inbox
620px wide: panel left edge is off-screen (header shows `box 1`), `All` chip unreachable, panel overlaps the Dock, no horizontal scroll to recover. No responsive rule for the panel.

### B9 (Observation, not filed) Open-then-Escape leaves a pending approval
Opening a review challenge and pressing Escape (abandoning) leaves a `pending` approval in `needs_you` until expiry (observed as an extra `Approval: task` row; later rejected through the UI). Likely acceptable TTL behavior, but every abandoned review adds queue noise.

---

## Notes and limits

- Approval TTL observed as 15:00 countdown; countdown and `expired` state were not exercised to expiry.
- Workspace had 0 nodes, so "panel does not break nodes" was checked only via canvas DOM + viewport transform + sessions dock, not via real node interactions.
- Tooling nuance: `button[aria-label="Refresh inbox"]` refuses synthetic pointer input because the icon `<svg>` is the hit target; a real click bubbles to the button. Not reported as a product bug.
- Test data mutations (all in `/tmp/webterm-p3-ui-data`): consumed the seeded approval, consumed two task-kind approvals for `t-review`, rejected two orphan approvals and one probe approval created by the B3 test. Final queue: `review me` (review), `broken thing` (broken).
- No commits made. Report + `p3-e2e-ui-assets/` are the only new files.
