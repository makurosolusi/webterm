# Inline style debt: final ledger

**Snapshot:** 2026-11-02, branch `feature/shadcn-ui`, HEAD `20a0ab3` plus the inline-cleanup working tree.
**Status:** final for the current UI scope. No source edit is claimed by this document.

## 1. Result

- Before cleanup: 71 `style={{...}}` props in `src/client` outside `components/ui`.
- After cleanup: 14 remaining, all runtime CSS custom properties:
  - `--menu-x` / `--menu-y` for context-menu coordinates
  - `--swatch` / `--node-swatch` for user-selected node colors
  - `--agent-color` for custom agent colors
  - `--dot-color` for canvas-menu dots
  - `--usage-pct` for the usage meter
- No static layout, spacing, typography, border, background, or sizing declarations remain inline in the cleaned lanes.

## 2. Converted lanes

| Lane | Files | Result |
|---|---|---|
| Onboarding | `Welcome.tsx`, `Login.tsx`, `ErrorBoundary.tsx`, `HelpOverlay.tsx` | Tailwind utilities for layout, typography, colors, icon sizes |
| Kanban / folder / find / usage | `Kanban.tsx`, `FolderPicker.tsx`, `FindBar.tsx`, `UsagePill.tsx` | Utilities; usage percentage remains `--usage-pct` |
| Node / terminal / menus / swatches | `NodeColorSwatch.tsx`, `TerminalNode.tsx`, `FilesNode.tsx`, `AgentNode.tsx`, `NodeContextMenu.tsx`, `CanvasContextMenu.tsx` | Utilities plus CSS-variable hooks for runtime coordinates/colors |
| Final stragglers | `chatComposer.tsx`, `Dock.tsx`, `CanvasMenuRow.tsx`, `EditorNode.tsx`, `SettingsAgents.tsx`, `TerminalCore.tsx`, `NodeChrome.tsx`, `NodeToolbar.tsx` | Utilities; runtime colors remain CSS variables |

## 3. Why 14 remain

CSS custom properties are the data channel, not a style declaration: menu coordinates, selected colors, custom agent colors, and meter percentage cannot be known at build time. A named CSS class consumes each variable, so no component writes `position`, `background`, `width`, or `border` inline.

## 4. Verification

- `rg -n 'style=\{\{' src/client --glob '*.tsx' | grep -v components/ui` → 14, all custom-property hooks.
- `tsc --noEmit`: clean.
- Full Vitest: 2029/2029 with `TMPDIR=/tmp`.
- Ego-browser: header tabs line variant, menus, sessions/inbox/chat/settings surfaces render and interact correctly.

## 5. Remaining rule

New code may use an inline style object only for a runtime CSS custom property consumed by a class. Static styling must use Tailwind utilities, an existing component primitive, or a named CSS class.
