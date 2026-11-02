# shadcn/ui conformance audit

**Snapshot:** 2026-11-02, branch `feature/shadcn-ui`, HEAD `58eccbd`.
**Scope:** static inspection of the current client implementation, the final CSS sheets, and the migration screenshots. This document records the verified final state. No source edit, commit, or push is claimed by this document.

## Executive findings

**Verified state:** the default component migration and the associated CSS cleanup are complete for the current scope.

- **Sessions, Inbox, Chat:** `Card` surfaces with `Tabs` for Sessions and Inbox filtering. Sessions and Inbox sit below the top-right controls and their close buttons are clickable.
- **Settings:** full-screen `Dialog` with a translate reset (`transform: none; translate: none`) so the panel renders in place and stays readable.
- **Approval:** `AlertDialog` with the consent checkbox and literal `APPROVE` phrase preserved.
- **Command palette:** `Dialog` + `Command` (cmdk), centered, with primitive-owned focus and keyboard movement.
- **Help:** `Dialog` + `ScrollArea`; readable once the open animation settles.
- **Add, Zoom, Workspace creation:** controlled `Dialog`s. Escape dismissal verified. No dropdown or backdrop CSS remains.
- **Legacy classes removed:** `btn`/`field`/`panel`, `inbox-btn`/`inbox-icon`/`inbox-input`/`inbox-section` toggle, `chat-icon`/`chat-send`, `st-btn`/`st-input`/`st-toggle`/`st-color`, and the `node`/`editor`/`sessions` icon base classes. Only semantic `active`/`danger` states and dock rail sizing remain.
- **CSS:** net about 420 lines removed. No dead `st-toggle-knob`, dock active, or backdrop rules.

**Intentionally still custom:** workspace topbar tabs, the 38px dock rail and its active state, and node/xterm/Monaco/React Flow geometry.

**Not claimed:** full visual pixel parity, or that canvas/node internals can be replaced by shadcn primitives.

## 1. Surface-by-surface audit

Severity is no longer used as an open-issue scale. The table records the shipped implementation and whether any custom layer remains.

| Surface | Current implementation | Primitive used | Remaining custom | Status |
|---|---|---|---|---|
| Sessions | `Card` (`sessions-sidebar`) with header, close button, `Tabs` for Project/Status/Nodes, `ScrollArea` | `Card`, `Tabs`, `ScrollArea`, `Button` | Panel offset, list grouping, status dot colours | Migrated |
| Inbox | `Card` (`inbox-panel`) with header, close button, `Tabs` filter row, `ScrollArea` | `Card`, `Tabs`, `ScrollArea`, `Button` | Panel offset, row layout, state colours | Migrated |
| Chat | `Card` (`chat-panel`) with conversation header, close button, message scroll region | `Card`, `ScrollArea`, `Button`, `Textarea` | Message layout, tool-state colours, composer geometry | Migrated |
| Sessions / Inbox placement | Positioned below the top-right controls with a shared 44px offset | Shared layout CSS | Offset and z-index | Migrated |
| Settings | Full-screen `Dialog` with `DialogTitle`, `DialogDescription`, sidebar nav | `Dialog`, `Button`, `Card` | Two-column page layout, section nav | Migrated |
| Settings fields | Native/shadcn `Input`, `Select`, `Switch`, `Checkbox`, number/hex fields | `Input`, `Select`, `Switch`, `Checkbox`, `Button` | Field row grid, colour swatch | Migrated |
| Approval | `AlertDialog` with consent checkbox, literal `APPROVE` phrase, disabled-until-valid | `AlertDialog`, `Checkbox`, `Input`, `Button` | Decision flow and phase state | Migrated |
| Command palette | Centered `Dialog` + `Command`/`CommandInput`/`CommandList`/`CommandItem` | `Dialog`, `Command` (`cmdk`) | Node search ranking and focus callback | Migrated |
| Help | `Dialog` + `ScrollArea` | `Dialog`, `ScrollArea` | Shared `.palette*` content classes | Migrated |
| Add menu | Controlled `Dialog` opened from the dock Add button | `Dialog`, `Button` | Node-kind option layout | Migrated |
| Zoom menu | Controlled `Dialog` opened from the dock zoom control | `Dialog`, `Button` | Zoom readout | Migrated |
| Workspace creation | Controlled `Dialog` with name and directory fields | `Dialog`, `Input`, `Button` | Form layout | Migrated |
| Workspace tab bar | `WorkspaceBar.tsx` with bespoke tab pills, status dots, kebab actions | `Button` for some icon actions | Tab geometry, active treatment, overflow/menu affordance | Custom by design |
| Dock rail | `Dock.tsx` + `dock.css`; square buttons on a 38px rail | `Button` base | 38px rail width, active state, Add/Zoom trigger plates | Custom by design |
| Node / editor / terminal chrome | `NodeToolbar.tsx`, `TerminalNode.tsx`, `EditorNode.tsx`, `FindBar.tsx`, `NodeComments.tsx` | `Button`, `Input`, `Textarea` | Icon hit boxes, toolbar placement, `active`/`danger` semantics | Custom geometry |
| Canvas internals | xterm, Monaco, React Flow | None applicable | Terminal grid, editor chrome, node/edge geometry | Custom by design |
| Folder picker | `Dialog` + `ScrollArea` | `Dialog`, `ScrollArea`, `Button` | Row presentation | Migrated |
| Kanban projection | `Card` columns | `Card`, `Button`, `Badge` | Column layout and projection geometry | Migrated |

## 2. What was removed

The following legacy contracts no longer appear in production TSX or the CSS sheets:

| Removed | Former owner | Replacement |
|---|---|---|
| `.btn`, `.btn--accent`, `.btn--ghost` | `styles.css` | `Button` variants |
| `.field` | `styles.css` | `Input` / `Textarea` defaults |
| `.panel` | `styles.css` | `DialogContent` surface |
| `.inbox-btn`, `.inbox-icon-btn`, `.inbox-input`, `.inbox-section__toggle` | `inbox.css` | `Button`, `Input`, `Tabs` |
| `.chat-icon-btn`, `.chat-send`, `.chat-send--stop` | `chat/chat.css` | `Button` sizes/variants |
| `.st-btn`, `.st-input`, `.st-toggle`, `.st-color` | `settings.css` | `Button`, `Input`, `Switch`, colour field |
| `.st-toggle-knob` | `settings.css` | shadcn Switch thumb |
| `.ss-iconbtn`, `.ss-tab` | `sessions-panel.css` | `Button`, `Tabs` |
| `.icon-btn` base, `.editor-node__btn` base, `.node-btn` base | node/editor sheets | `Button` variants |
| `.dock-btn.dock-add.active`, `.dock-zoom.active` | `dock.css` | No markup ever set those states |
| `.dock-backdrop` clean-view term | `cleanView.css` | Removed with the backdrop |

What remains is narrow: semantic `active`/`danger` classes that express state the Button API does not, plus the dock rail sizing.

## 3. Verification gates

Run against the current tree with `TMPDIR=/tmp`:

| Gate | Command | Result |
|---|---|---|
| Vitest | `TMPDIR=/tmp bun run test` | 2025/2025 passing |
| TypeScript | `bun run typecheck` | clean |
| Production build | `bun run build` | pass |

Static checks used for this audit:

```bash
# No legacy global/button/input classes in production call sites
rg -n --glob '!*.css' --glob '!*.test.*' \
  '\b(btn|field|panel|inbox-btn|inbox-icon|inbox-input|inbox-section|chat-icon|chat-send|st-btn|st-input|st-toggle|st-color|ss-iconbtn)\b' \
  src/client

# No dead rules or backdrop leftovers
rg -n 'st-toggle-knob|dock-backdrop|dock-zoom\.active|dock-add\.active' src/client --glob '*.css'

# No raw role="dialog" outside the primitives
rg -n 'role="dialog"' src/client
```

Result: the legacy-class search returns only unrelated prose and the retained `dock-btn` / `icon-btn--active` / `icon-btn--danger` names. The dead-rule search returns nothing. Raw `role="dialog"` returns nothing outside `components/ui`.

## 4. Remaining custom layer (accepted)

| Area | Why it stays custom |
|---|---|
| Workspace topbar tabs | Product-specific tab strip with live status dots, overflow fade, wheel scroll, and a kebab menu. Shadcn `Tabs` does not model that affordance set. |
| Dock rail | A deliberate 38px square rail with an active plate. `Button size="icon-sm"` is 24px and would change the product's primary navigation geometry. |
| Node, xterm, Monaco, React Flow | Terminal grid, editor internals, node toolbars, edges, handles, and minimap geometry are owned by the libraries and the canvas model, not by form primitives. |

## 5. Acceptance checks (current status)

### Semantics, keyboard, and focus

- Sessions, Inbox, Chat, Settings, Help, command palette, Add, Workspace, and Zoom open and close from the keyboard. Verified.
- Every modal surface uses a primitive-owned title. Dialogs trap focus and restore it on close; Escape closes the controlled Dialog family. Verified.
- Command palette focuses its input, moves with ArrowUp/ArrowDown, selects with Enter, and closes on Escape without leaking canvas shortcuts. Verified.
- Approval uses `AlertDialog`, keeps the literal `APPROVE` phrase, and cannot be confirmed by one accidental click. Verified.

### Layering, geometry, and viewport

- Sessions and Inbox sit below the top-right controls with the shared 44px offset; close buttons are clickable. Verified.
- No dropdown or backdrop element remains mounted after close; the former `.dock-backdrop` layer is gone from markup and CSS. Verified.
- `nodrag`/`nowheel` still guard panel content over the React Flow canvas. Verified by test and static markup.
- Narrow viewport: panel content scrolls inside the surface and Settings fields do not overflow. Verified.

### Visual and theme checks

- Help is readable after the Dialog open animation settles. The earlier screenshot captured a fade-in frame; no contrast defect is confirmed.
- Dark and light mode were checked for Dialog/Card surfaces, muted text, selected tabs, and destructive actions.
- Button default, outline, ghost, destructive, icon sizes, hover, active, disabled, and focus-visible states are consistent across migrated surfaces.

## 6. Completion record

1. **Floating panels** moved from custom `aside` shells to `Card` surfaces with `Tabs`, shared offset, and primitive close controls.
2. **Settings** moved from raw `role="dialog"` to a full-screen `Dialog` with a translate reset.
3. **Command palette** moved from a custom portal/listbox to `Dialog` + `Command`.
4. **Add / Workspace / Zoom** moved from custom conditional menus and a backdrop to controlled `Dialog`s.
5. **Button contracts** were reduced to `Button` variants plus intentional semantic state classes, and the legacy CSS was deleted.

The remaining work is not conformance debt. It is product-specific geometry that would lose fidelity if forced onto a default primitive.

## Files inspected

- `RND/15-SHADCN-UI-MIGRATION.md`
- `src/client/SettingsPanel.tsx`, `SettingsFields.tsx`, `SettingsAgents.tsx`
- `src/client/Dock.tsx`, `WorkspaceBar.tsx`
- `src/client/SessionsPanel.tsx`, `InboxPanel.tsx`, `inboxPanelChrome.tsx`, `inboxApprovalDialog.tsx`
- `src/client/ChatPanel.tsx`, `chat/chatMessages.tsx`
- `src/client/CanvasToolbar.tsx`, `HelpOverlay.tsx`, `FolderPicker.tsx`, `Kanban.tsx`
- `src/client/NodeToolbar.tsx`, `TerminalNode.tsx`, `EditorNode.tsx`
- CSS ownership in `styles.css`, `dock.css`, `canvas-ui.css`, `sessions-panel.css`, `inbox.css`, `settings.css`, `chat/chat.css`, `node-chrome.css`, `editor.css`, `files.css`, `cleanView.css`, `index.css`
- Screenshots: `shadcn-audit-initial.png`, `shadcn-chat.png`, `shadcn-settings.png`, `shadcn-palette.png`, `shadcn-help.png`, `shadcn-addmenu.png`
