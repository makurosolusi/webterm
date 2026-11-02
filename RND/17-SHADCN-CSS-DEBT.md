# shadcn CSS debt: final ledger

**Snapshot:** 2026-11-02, branch `feature/shadcn-ui`, HEAD `58eccbd`.
**Scope:** the 13 client stylesheets, cross-checked against every `src/client/**/*.ts(x)` and `index.html`.
**Status:** final record. No source edit, deletion, commit, or push is claimed by this document.

## 1. Final state

- Presentation CSS is now approximately 2,750 lines, a net reduction of about **420 lines** from the pre-migration baseline.
- No dead `st-toggle-knob` rules remain.
- No dead dock active selectors remain.
- No `dock-backdrop` rule or clean-view reference remains.
- Every remaining sheet has a live owner: design tokens, layout/geometry, dynamic status families, or third-party internals (xterm, Monaco, React Flow).

There is no open "safe to delete" queue. Further removal requires a new audit and a visual diff.

## 2. Per-sheet ledger

Line counts measured on the current tree.

| Sheet | Lines | Remaining purpose | Debt status |
|---|---:|---|---|
| `index.css` | 44 | Tailwind import, layer order, `@theme` token mapping, scoped `button[data-slot]` reset | Intentional |
| `styles.css` | 403 | App shell, workspace topbar tabs, layout tokens | Intentional |
| `dock.css` | 173 | 38px dock rail, active plate, Add/Zoom trigger geometry | Intentional |
| `canvas-ui.css` | 163 | Canvas controls, command/help palette content, canvas overlays | Intentional |
| `node-chrome.css` | 308 | Node toolbar, terminal chrome, semantic `active`/`danger` states | Intentional |
| `agent.css` | 56 | Agent badge tokens | Intentional |
| `editor.css` | 215 | Monaco wrapper, editor node body variants, image/PDF preview | Intentional |
| `files.css` | 115 | File manager layout and breadcrumb geometry | Intentional |
| `sessions-panel.css` | 418 | Session panel placement, row grouping, status dots | Intentional |
| `inbox.css` | 306 | Inbox panel placement, row layout, state colours | Intentional |
| `chat/chat.css` | 349 | Chat panel placement, message layout, tool-state colours | Intentional |
| `settings.css` | 140 | Full-screen dialog layout, field grid, colour swatch | Intentional |
| `cleanView.css` | 64 | Clean-view hide list and hint | Intentional |
| **Total** | **2,754** | | |

## 3. Removed legacy contracts

These are gone from production TSX and from the CSS sheets. The "replacement" column is what now owns the appearance or behaviour.

| Removed | Former owner | Replacement |
|---|---|---|
| `.btn`, `.btn--accent`, `.btn--ghost` | `styles.css` | `Button` variants |
| `.field` | `styles.css` | `Input` / `Textarea` defaults |
| `.panel` | `styles.css` | `DialogContent` surface |
| `.inbox-btn`, `.inbox-icon-btn`, `.inbox-input`, `.inbox-section__toggle` | `inbox.css` | `Button`, `Input`, `Tabs` |
| `.chat-icon-btn`, `.chat-send`, `.chat-send--stop` | `chat/chat.css` | `Button` sizes/variants |
| `.st-btn`, `.st-input`, `.st-toggle`, `.st-color` | `settings.css` | `Button`, `Input`, `Switch`, colour field |
| `.st-toggle-knob` and `.st-toggle.is-on .st-toggle-knob` | `settings.css` | shadcn Switch thumb and `data-[state=checked]` |
| `.ss-iconbtn`, `.ss-tab` | `sessions-panel.css` | `Button`, `Tabs` |
| `.icon-btn` base, `.editor-node__btn` base, `.node-btn` base | node/editor sheets | `Button` variants |
| `.dock-btn.dock-add.active`, `.dock-zoom.active` | `dock.css` | No markup ever set those states |
| `.dock-backdrop` term in the clean-view hide list | `cleanView.css` | Removed with the backdrop |

What survives under a legacy name is narrow and intentional: `dock-btn` for the 38px rail, and `icon-btn--active` / `icon-btn--danger` as semantic state classes on node toolbar buttons. There are no `btn`, `field`, `panel`, inbox/chat/settings control, or icon-base classes left.

## 4. Do-not-delete list

| Category | Selectors / classes | Reason |
|---|---|---|
| Design tokens | `:root`, `:root[data-theme='light']`, `@theme inline` in `index.css` | Single source for surfaces, accent, status and geometry. `styles.test.ts` asserts specific token literals. |
| React Flow internals | `.react-flow__minimap`, `.react-flow__handle.bridge-handle`, `.react-flow__node:has(.term-node.working)`, `.react-flow__node:has(.term-node.attention)` | Applied by `@xyflow/react` at runtime, not by JSX strings. A static grep finding zero references is expected. |
| xterm / Monaco | xterm stylesheet import, `.editor-node__monaco`, `.editor-node__body--pdf iframe`, `.editor-node__body--image img` | External libraries own internal class names. Wrapper selectors still control layering. |
| Dynamic families | `tab__dot--*`, `term-node.working/waiting/attention`, `ss-status__icon--*`, `ss-dot--*`, `inbox-state--*`, `chat-message--*`, `chat-tool__state--*`, `editor-node__body--*` | Values are produced by template literals; static analysis cannot enumerate them. Removing one variant loses a runtime state. |
| Layout and positioning | `.app-shell`, `.app-main`, `.tabbar`, `.dock`, `.sessions-sidebar`, `.chat-panel`, `.inbox-panel`, `.palette-overlay`, `.node-menu`, `.files-menu`, `.controls-cluster`, `.clean-view-hint` | Primitives replaced controls, not canvas geometry. These own placement, offset and z-index. |
| Shared `@import` chain | `styles.css` imports for `node-chrome.css` and `dock.css` | `styles.test.ts` asserts both imports precede the first rule. |
| Primitive-slot hooks | `.inbox-filters > [data-slot='tabs']`, `.inbox-panel`, `.st-dialog-content`, `.inbox-dialog` | Selectors intentionally target shadcn `data-slot` roots or the className passed to the primitive. The element exists; the class is the bridge. |
| Semantic state classes | `.dock-btn.active`, `icon-btn--active`, `icon-btn--danger`, `.st-dialog-content` translate reset | Express state the Button/Dialog API does not, or pin a layout correction. |

## 5. Verification

```bash
# 1. Dead-rule sweep: must return nothing
rg -n 'st-toggle-knob|dock-backdrop|dock-zoom\.active|dock-add\.active' src/client --glob '*.css'

# 2. Legacy control classes in production: only prose / retained semantic names
rg -n --glob '!*.css' --glob '!*.test.*' \
  '\b(btn|field|panel|inbox-btn|inbox-icon|inbox-input|inbox-section|chat-icon|chat-send|st-btn|st-input|st-toggle|st-color|ss-iconbtn)\b' \
  src/client

# 3. Guard the dynamic families before any future cleanup
rg -n 'tab__dot--|ss-status__icon--|ss-dot--|inbox-state--|chat-message--|chat-tool__state--|editor-node__body--|term-node\.(working|waiting|attention)' src/client --glob '*.css'

# 4. Raw dialogs must live only in the primitives
rg -n 'role="dialog"' src/client
```

Observed:

- The dead-rule sweep returns nothing.
- The legacy-class sweep returns only Indonesian prose (`field`/`panel` as words) plus the retained `dock-btn`, `icon-btn--active`, and `icon-btn--danger` names.
- The dynamic-family sweep returns the live rules listed in section 4.
- `role="dialog"` appears only inside `components/ui`.

Gates, run with `TMPDIR=/tmp`:

| Gate | Command | Result |
|---|---|---|
| Vitest | `TMPDIR=/tmp bun run test` | 2025/2025 passing |
| TypeScript | `bun run typecheck` | clean |
| Production build | `bun run build` | pass |

## 6. Remaining custom CSS (accepted)

| Area | Why it stays custom |
|---|---|
| Workspace topbar tabs | Product-specific tab strip with live status dots, overflow fade, wheel scroll, and a kebab menu. |
| Dock rail | A deliberate 38px square rail with an active plate. `Button size="icon-sm"` is 24px and would change the primary navigation geometry. |
| Node, xterm, Monaco, React Flow | Terminal grid, editor internals, node toolbars, edges, handles, and minimap geometry are owned by the libraries and the canvas model. |
| Dynamic status families | Colour and icon variants are driven by runtime state, not by a static class list. |

## 7. Bottom line

- Net CSS reduction is about 420 lines, to roughly 2,750 lines of presentation CSS.
- The dead rules named in earlier audits (`st-toggle-knob`, dock active branches, `dock-backdrop`) are removed and no longer have a replacement owner.
- No further deletion is authorized by this ledger. Any future cleanup needs a fresh static audit plus a visual diff of the affected surface.
