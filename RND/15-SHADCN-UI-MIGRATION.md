# shadcn/ui migration inventory and parallel plan

**Snapshot:** 2026-11-02, branch `feature/shadcn-ui`  
**Verified state:** shadcn `command` and `popover` are available, with `cmdk` added. The migration covers the documented shell surfaces and default component compositions below. Canvas, xterm, Monaco, React Flow, and geometry-sensitive chrome remain intentionally custom. This is not a full pixel-parity claim.

## 1. Scope and non-goals

Migrate presentational chrome to the existing shadcn foundation without changing product behavior. Keep xterm canvas and terminal rendering, React Flow canvas/minimap/edges, Monaco internals, and custom drag/resize/viewport geometry. shadcn should wrap controls, menus, dialogs, sheets, cards, badges, fields, tabs, separators, and tooltips around those internals, not replace them.

Non-goals: new primitives, visual redesign, global reset, token rewrite, replacing native semantics merely for styling, changing persisted layout or keyboard contracts, or changing server/API behavior.

## 2. Foundation summary

Available in `src/client/components/ui`: `alert-dialog`, `badge`, `button`, `card`, `checkbox`, `command`, `dialog`, `dropdown-menu`, `input`, `label`, `popover`, `progress`, `scroll-area`, `select`, `separator`, `sheet`, `skeleton`, `switch`, `tabs`, `textarea`, and `tooltip`. `shadcn-foundation.test.tsx` is the existing foundation smoke test. `tsconfig.json` maps `@/*` to `src/client/*`; use imports such as `@/components/ui/button`. Existing dependencies include Radix, `class-variance-authority`, `clsx`, and `tailwind-merge`.

`index.css` imports Tailwind v4 theme/utilities and `tw-animate-css`, but deliberately has no preflight. Existing styles own reset and component presentation. Tokens map shadcn names to existing variables (`--bg`, `--text`, `--panel`, `--overlay`, `--accent`, `--border`, etc.). The foundation components import `cn` from `@/lib/utils`; use that existing path and do not add or imply an npm `cn` package. Foundation snapshot is commit `5429526`. No-preflight means every migrated control must retain explicit font, color, border, focus, disabled, and box-sizing behavior where the old sheets supplied it.

## 3. UI inventory

Legend: **S/M/L** is migration complexity. Risk names the behavior suites or contracts to re-run. CSS names are the sheets currently owning presentation.

| File(s) | Purpose and current CSS | Target primitives | Size / risk | Wave |
|---|---|---|---|---|
| `App.tsx`, `main.tsx`, `ErrorBoundary.tsx` | app mount, shell composition, error surface; `styles.css` | Card, AlertDialog only where already modal | M / boot and error selectors | 1 |
| `WorkspaceBar.tsx` | workspace/top bar; `styles.css`, `canvas-ui.css` | Button, Input, DropdownMenu, Tooltip, Separator | M / `workspaceBarChrome`, workspace commit | 1 |
| `Dock.tsx`, `CanvasToolbar.tsx` | left dock and canvas controls; `dock.css`, `canvas-ui.css` | Button, Tooltip, DropdownMenu, Separator, Badge | L / dock sessions, merge, clean-view tests | 1 |
| `CanvasMenuRow.tsx`, `canvasMenu.pane.tsx`, `CanvasContextMenu.tsx` | canvas/node menus and submenus; `agent.css`, `canvas-ui.css` | DropdownMenu primitives, Separator | L / geometry/model/context-menu suites | 1, after dock menu contract |
| `cleanView.tsx` | body mode and hint; `cleanView.css` | Button/Tooltip only for hint | S / body class and visibility tests | 6 |
| `NodeChrome.tsx`, `NodeToolbar.tsx`, `NodeContextMenu.tsx` | node frame, toolbar, menu; `node-chrome.css`, `agent.css` | Button, Tooltip, DropdownMenu, Separator | L / pane split, node menu, chrome tests | 2 |
| `NodeComments.tsx`, `NodeColorSwatch.tsx` | comments and color controls; `node-chrome.css` | Textarea, Popover-equivalent only if available, Button | M / node toolbar selectors | 2 |
| `TerminalNode.tsx`, `TerminalCore.tsx` | xterm node and terminal lifecycle; `node-chrome.css`, `styles.css` | Button/Tooltip around xterm only | L / terminal core/menu, xterm internals frozen | 2 |
| `AgentNode.tsx`, `NodeToolbar.tsx` | agent node actions/status; `agent.css`, `node-chrome.css` | Button, Badge, Tooltip, DropdownMenu | L / agent action/toolbar/spawn | 2 |
| `EditorNode.tsx`, `lazyMonaco.tsx` | file editor/preview; `editor.css` | Button, Badge, Card around Monaco; Monaco unchanged | L / editor/file-open edge tests | 3 |
| `FilesNode.tsx`, `FolderPicker.tsx` | file browser and picker; `files.css`, `editor.css` | Button, Input, Dialog, ScrollArea, Skeleton | L / file browse/open/keys | 3 |
| `FindBar.tsx` | xterm/editor search bar; `styles.css`, `editor.css` | Input, Button, Tooltip | M / keyboard and search addon behavior | 3 |
| `SessionsPanel.tsx`, `SessionRow.tsx` | sessions sidebar/list; `sessions-panel.css` | Sheet or Card, Input, Button, ScrollArea, Badge | L / sessions panel open and dock state | 4 |
| `InboxPanel.tsx`, `inboxPanelChrome.tsx`, `inboxPanelSections.tsx`, `inboxItemRow.tsx` | inbox list and filters; `inbox.css` | Sheet/Card, Tabs, Badge, ScrollArea, Button | L / InboxPanel, recovery, fence, dock badge | 4 |
| `inboxPanelDialog.tsx`, `inboxApprovalDialog.tsx` | approval/recovery dialogs; `inbox.css` | AlertDialog, Dialog, Checkbox, Input, Button | M / literal `APPROVE`, disabled state, focus | 4 |
| `Kanban.tsx` | kanban projection/cards; `styles.css`, `inbox.css` | Card, Badge, Button, Tabs | M / kanban test and data semantics | 4 |
| `ChatPanel.tsx`, `chat/chatConversation.tsx`, `chat/chatMessages.tsx`, `chat/chatComposer.tsx` | central chat shell, stream, markdown, composer; `chat/chat.css` | Sheet/Card, ScrollArea, Textarea, Button, Badge, Skeleton | L / ChatPanel and chat state/API tests | 5 |
| `SettingsPanel.tsx`, `SettingsAgents.tsx`, `SettingsFields.tsx` | settings forms; `settings.css` | Sheet/Card, Tabs, Label, Input, Select, Switch, Textarea, Button | L / settings keyboard and persistence | 5 |
| `Welcome.tsx`, `Login.tsx` | onboarding/auth surfaces; `styles.css` | Card, Input, Label, Button, Alert | M / welcome and Login tests | 6 |
| `HelpOverlay.tsx` | keyboard/help overlay; `styles.css`, `canvas-ui.css` | Dialog, ScrollArea, Badge, Button | M / keyboard dismissal and focus | 6 |
| `UsagePill.tsx` | usage/status pill; `styles.css` | Badge, Tooltip, Progress | S / text/status only | 1 |
| `ContextEdge.tsx`, `PaneView.tsx`, `nodeTypes.tsx`, `canvasHarness.tsx` | React Flow edge/view/node registry/test harness; custom canvas | None, except chrome children | S / preserve React Flow internals | 7 audit only |
| `chat/*` non-UI stores/tests | state/render support; `chat.css` consumers | No primitive migration | S / state tests | 5 audit only |

**Foundation files** (`components/ui/*.tsx`) are already the target layer, not migration targets. Do not change them in feature lanes unless a failing contract proves a foundation defect.

## 4. CSS sheet disposition

| Sheet | Disposition | Reason / dependency |
|---|---|---|
| `index.css` | Keep, trim only after all waves | Tailwind v4 utilities/theme, token bridge, no preflight. First-loaded foundation. |
| `styles.css` | Keep, then trim | Global reset, tokens, app shell, shared surfaces. Must remain until all consumers move. |
| `node-chrome.css` | Keep, trim after wave 2 | Node geometry and chrome; xterm-adjacent rules stay. |
| `agent.css` | Keep, trim after wave 2 | Node menu styling shared with canvas menus. |
| `canvas-ui.css` | Keep, trim after wave 1/2 | Canvas controls and geometry-sensitive submenu positioning stay. |
| `dock.css` | Keep, trim after wave 1 | Dock geometry, backdrop, badge, menu placement. |
| `sessions-panel.css` | Keep, trim after wave 4 | Sidebar displacement uses `--dock-w`; preserve layout tokens. |
| `inbox.css` | Keep, trim after wave 4 | Approval/list state styling and panel geometry. |
| `chat/chat.css` | Keep, trim after wave 5 | Markdown, streaming, proposal blocks, panel layout. |
| `settings.css` | Keep, trim after wave 5 | Form layout and settings-specific behavior. |
| `editor.css` | Keep, trim after wave 3 | Monaco, image/PDF/markdown preview, editor geometry. |
| `files.css` | Keep, trim after wave 3 | File tree/list geometry and selection behavior. |
| `cleanView.css` | Keep | Body mode visibility and hint animation are not primitive styling. |

Dependency order: `index.css` token bridge -> `styles.css` reset/tokens -> shell/dock/canvas -> node chrome -> editor/files -> sessions/inbox -> chat/settings -> overlays/onboarding -> final dead-rule trim. Retire a sheet only when search proves no selectors remain and its behavior tests pass. No sheet is currently safe to retire.

## 5. Parallel wave plan, 7 agents

Ownership is file-based and non-overlapping. Shared CSS is edited only by the named owner in that wave. If a lane needs another lane's component, consume its public props and sequence after that lane, do not edit the file.

1. **Shell/topbar/dock:** `App.tsx`, `main.tsx`, `WorkspaceBar.tsx`, `Dock.tsx`, `CanvasToolbar.tsx`, `CanvasMenuRow.tsx`, `canvasMenu.pane.tsx`, `CanvasContextMenu.tsx`, `UsagePill.tsx`; owns `dock.css`, `canvas-ui.css` menu/control rules. Does not edit tests, `styles.css`, or `index.css`.
2. **Node/terminal chrome:** `NodeChrome.tsx`, `NodeToolbar.tsx`, `NodeContextMenu.tsx`, `NodeComments.tsx`, `NodeColorSwatch.tsx`, `TerminalNode.tsx`, `TerminalCore.tsx`, `AgentNode.tsx`; owns `node-chrome.css`, `agent.css`. Does not edit tests, `styles.css`, or `index.css`.
3. **Editor/files:** `EditorNode.tsx`, `lazyMonaco.tsx`, `FilesNode.tsx`, `FolderPicker.tsx`, `FindBar.tsx`; owns `editor.css`, `files.css`. Does not edit tests, `styles.css`, or `index.css`.
4a. **Sessions:** `SessionsPanel.tsx`, `SessionRow.tsx`; owns `sessions-panel.css`. Does not edit tests, `styles.css`, or `index.css`.
4b. **Inbox/kanban:** `InboxPanel.tsx`, `inboxPanelChrome.tsx`, `inboxPanelSections.tsx`, `inboxItemRow.tsx`, `inboxPanelDialog.tsx`, `inboxApprovalDialog.tsx`, `Kanban.tsx`; owns `inbox.css`. Does not edit tests, `styles.css`, or `index.css`.
5a. **Chat:** `ChatPanel.tsx`, `chat/chatConversation.tsx`, `chat/chatMessages.tsx`, `chat/chatComposer.tsx`; owns `chat/chat.css`. Does not edit tests, `styles.css`, or `index.css`.
5b. **Settings:** `SettingsPanel.tsx`, `SettingsAgents.tsx`, `SettingsFields.tsx`; owns `settings.css`. Does not edit tests, `styles.css`, or `index.css`.
6. **Overlays/onboarding:** `Welcome.tsx`, `Login.tsx`, `HelpOverlay.tsx`, `cleanView.tsx`, `ErrorBoundary.tsx`; owns `cleanView.css` only. Use component-level utilities/classes and preserve existing class hooks. Does not edit tests, `styles.css`, or `index.css`.
7. **Final CSS/tokens/tests:** `index.css`, remaining `styles.css`, `ContextEdge.tsx`, `PaneView.tsx`, `nodeTypes.tsx`, `canvasHarness.tsx`, and all affected client tests. This lane runs after 1-6, removes only proven dead rules, and never edits production components owned by another lane. It is the only lane allowed to edit `styles.css` or `index.css`.

Hard rule: waves 1-6 must not edit any `*.test.ts` or `*.test.tsx` files. Preserve legacy `className` hooks, roles, `aria-*`, and `data-testid` values so existing tests keep passing. Wave 7 may update tests only when a real semantic DOM change requires it.

## 6. Per-wave acceptance

- Behavior parity: existing tests pass, including keyboard shortcuts, pointer/menu geometry, drag/resize, xterm attach/search/clipboard, Monaco open/save, approval phrase and fence checks, chat streaming, settings persistence, and clean-view body state.
- A11y/keyboard: preserve native buttons/inputs, roles, labels, `aria-*`, focus return, Escape handling, disabled and `aria-disabled` states, tab order, and menu navigation.
- Tests: run `TMPDIR=/tmp/st npm test` and `TMPDIR=/tmp/st npm run typecheck` for each integrated wave. Update selectors only for a real semantic DOM change, not cosmetic class replacement.
- Visual checks: compare normal, narrow viewport, dark theme, focused/disabled/error/loading states, open menus/dialogs/sheets, clean view, and canvas overlays. Confirm no Tailwind preflight changed typography or margins.

## 7. Top 10 risks and checks

1. No-preflight differences: compare computed font, box sizing, buttons, inputs, headings.
2. Radix portal stacking: open nested menus/dialogs over React Flow and xterm.
3. Focus loss: test Escape, focus return, Tab loops, and keyboard menu navigation.
4. `aria-disabled` versus `:disabled`: retain explicit visual and click guards.
5. Canvas geometry regression: run menu geometry/context-menu and viewport suites.
6. Drag/resize event capture: test node handles, pane split, and pointer events after wrappers.
7. xterm/Monaco sizing: verify ResizeObserver/client rects and no wrapper-induced height collapse.
8. Selector coupling: search `data-testid`, roles, class selectors, and test helpers before changing markup.
9. Shared CSS order: remove rules only after dependency search and full client tests.
10. Token drift: compare existing CSS variables and shadcn mappings; do not invent a second theme.

## 8. Agent migration checklist

- Preserve `aria-*`, roles, labels, `data-testid`, native button/input semantics, keyboard handlers, and disabled behavior.
- Use `@/components/ui/*` and `cn`; do not add global resets or alter `index.css` preflight policy.
- Keep xterm, React Flow canvas/minimap/edges, Monaco internals, drag geometry, resize math, and persisted layout untouched.
- Wrap chrome only. Keep `className` hooks that tests or geometry code consume until replacement evidence exists.
- Check portal z-index, focus restoration, reduced motion, overflow, and narrow viewport behavior.
- Update tests only when semantic DOM really changes. Cosmetic class changes should not weaken assertions.
- Record any unavoidable selector or CSS deletion with the owning wave and a passing test command.

## 9. Not yet migrated ledger

Status as of 2026-11-02: the foundation and two migration waves are complete. This ledger records migrated chrome and controls without claiming full shell conversion or pixel parity.

### Completed foundation

- Commit `5429526` adds the Tailwind v4 utilities-only foundation, with no preflight, the `@` alias to `src/client`, shadcn primitives under `src/client/components/ui`, and `cn` from `@/lib/utils`.
- The foundation preserves the existing reset and presentation ownership. The 12 legacy presentation sheets remain intentionally retained alongside `index.css` while custom consumers and geometry-sensitive rules still depend on them.

### Migrated production files

- **Wave 1, commit `b0763d2`, 33 files:** `CanvasMenuRow.tsx`, `CanvasToolbar.tsx`, `ChatPanel.tsx`, `Dock.tsx`, `EditorNode.tsx`, `ErrorBoundary.tsx`, `FilesNode.tsx`, `FindBar.tsx`, `FolderPicker.tsx`, `HelpOverlay.tsx`, `Kanban.tsx`, `Login.tsx`, `NodeChrome.tsx`, `NodeColorSwatch.tsx`, `NodeComments.tsx`, `NodeContextMenu.tsx`, `NodeToolbar.tsx`, `SessionRow.tsx`, `SessionsPanel.tsx`, `SettingsAgents.tsx`, `SettingsFields.tsx`, `SettingsPanel.tsx`, `TerminalNode.tsx`, `UsagePill.tsx`, `Welcome.tsx`, `WorkspaceBar.tsx`, `chat/chatComposer.tsx`, `chat/chatConversation.tsx`, `chat/chatMessages.tsx`, `inboxApprovalDialog.tsx`, `inboxItemRow.tsx`, `inboxPanelChrome.tsx`, and `node-chrome.css`.
- **Wave 2, commit `1020737`, 8 files:** `CanvasToolbar.tsx`, `Kanban.tsx`, `NodeChrome.tsx`, `NodeContextMenu.tsx`, `SessionsPanel.tsx`, `inboxApprovalDialog.tsx`, `inboxItemRow.tsx`, and `inboxPanelSections.tsx`. This wave completed the remaining raw `Checkbox`/`Input`/`Button` control migration in inbox, approval, sessions, and shell paths.
- Current raw-control audit: `rg -n '<button|<input|<textarea|<select' src/client --glob '*.tsx' | grep -v components/ui` returns two intentional matches only: the native color-input documentation comment in `SettingsFields.tsx` and a test fixture in `inboxDockState.test.tsx`. No remaining production raw-control markup was found by this audit.

### Remaining structural items

- Sessions, Inbox, and Chat use Card surfaces rather than Sheet; their panel placement remains intentionally custom.
- Settings uses a controlled full-screen Dialog. Inbox approval uses AlertDialog.
- The Canvas command palette uses Dialog + Command. Add, Zoom, and Workspace creation use controlled Dialogs.
- Canvas, xterm, Monaco, React Flow internals, and geometry-sensitive drag/resize/viewport behavior remain intentionally custom and were not candidates for replacement.
- Twelve presentation sheets remain intentionally for layout, tokens, xterm, React Flow, Monaco, dynamic states, and custom geometry.
- Real UI verification was completed with ego-browser. Sessions Card/Tabs, Inbox and Chat placement, full-screen Settings, centered Command palette, Add/Zoom Escape dismissal, readable Help, and no white user-agent tab pills were checked. Full pixel parity and full shell migration are not claimed.
