# VS Code UI/UX parity plan for webterm

**Snapshot:** 2026-11-02, branch `feature/vscode-ui`, HEAD unknown at read time.
**Scope:** analysis and implementation planning only. No source edit, commit, or push is claimed by this document.
**Goal:** make the webterm chrome read and behave like VS Code (dark and light modern themes), use `@vscode-elements/react-elements` where it is a real fit, build the missing VS Code primitives, and keep terminal, xterm, Monaco, React Flow, node geometry, pane splits, persistence, and server contracts untouched.

This is not a claim that webterm becomes VS Code. The target is **100 percent VS Code-like chrome**, measured by layout metrics, color tokens, typography, keyboard behavior, and visual acceptance at 1440 and 1778 wide. The canvas, nodes, terminal, and file editor remain webterm surfaces wrapped in VS Code chrome.

---

## 0. Verified facts, decisions, non-goals

### 0.1 Verified package facts (2026-11-02)

| Fact | Value |
|---|---|
| `@vscode-elements/react-elements` latest | `2.4.0` |
| `@vscode-elements/elements` latest | `2.5.1` |
| React wrapper peer range | React 17, 18, 19. Project uses React 19.3.1, compatible |
| React wrappers exported | 39 components, listed in section 0.2 |
| Elements bundle size | `bundled.js` 233,123 bytes minified, 49,625 bytes gzip for all 39 elements |
| Shadow parts exposed | Only `vscode-button` exposes `part="base"`. Other styling goes through inherited CSS custom properties |
| Icon font | `vscode-icon` requires `@vscode/codicons` CSS loaded with id `codicon-stylesheet` |
| Editor tabs | `vscode-tabs` is a **panel tab** component: active tab uses a bottom border. It is not a VS Code editor tab strip (top border, closable, dirty state, overflow) |
| Context menu | `vscode-context-menu` supports flat items only. No icons, submenus, disabled rows, danger rows, or checkbox rows |

### 0.2 Components actually available

`VscodeBadge`, `VscodeButton`, `VscodeButtonGroup`, `VscodeCheckbox`, `VscodeCheckboxGroup`, `VscodeCollapsible`, `VscodeContextMenu`, `VscodeContextMenuItem`, `VscodeDivider`, `VscodeFormContainer`, `VscodeFormGroup`, `VscodeFormHelper`, `VscodeIcon`, `VscodeLabel`, `VscodeMultiSelect`, `VscodeOption`, `VscodeProgressBar`, `VscodeProgressRing`, `VscodeRadio`, `VscodeRadioGroup`, `VscodeScrollable`, `VscodeSingleSelect`, `VscodeSplitLayout`, `VscodeTabHeader`, `VscodeTable`, `VscodeTableBody`, `VscodeTableCell`, `VscodeTableHeader`, `VscodeTableHeaderCell`, `VscodeTableRow`, `VscodeTabPanel`, `VscodeTabs`, `VscodeTextarea`, `VscodeTextfield`, `VscodeToolbarButton`, `VscodeToolbarContainer`, `VscodeTree`, `VscodeTreeItem`.

Not available and must be built: title bar, menu bar, activity bar, status bar, editor tab strip, dialog, quick pick / command palette, notification, popover, tooltip, breadcrumbs, find widget, resizable docked panel.

### 0.3 Primary decision: hybrid primitive strategy

Use VS Code Elements for structural and display-heavy controls, and keep native or shadcn form controls restyled to the VS Code spec.

| Use VS Code Elements | Keep native or shadcn restyled | Build custom |
|---|---|---|
| `VscodeTabs` for panel tabs (Inbox/Chat), `VscodeTree` for Sessions/File tree, `VscodeToolbarContainer` and `VscodeToolbarButton`, `VscodeTable`, `VscodeBadge`, `VscodeProgressBar`, `VscodeProgressRing`, `VscodeCollapsible`, `VscodeSplitLayout` (bottom panel, optional), `VscodeSingleSelect` (settings, only after jsdom proof), `VscodeTextfield` / `VscodeTextarea` (only where tests do not need label association) | `button`, `input`, `textarea`, `checkbox`, `select` wrappers that match the exact VS Code metrics. Reason: testing-library cannot pierce shadow DOM, `getByLabelText` and `getByRole('button')` break, and shadow DOM label association is not automatic. Native controls keep the existing 19 test suites and screen-reader contracts | Title bar, menu bar, activity bar, status bar, editor tabs, dialog, quick pick, menu with submenus, tooltip, popover, notification, breadcrumbs, find widget, docked panel, file tree row |

This hybrid is deliberate. Replacing every button and input with a web component would force a full rewrite of the client tests plus lose label association, which is a worse outcome than a native control with exact VS Code styling. The plan still uses the package wherever the package adds real value.

### 0.4 Non-goals and frozen behavior

Frozen:
- xterm and PTY protocol, session ids, `open`/`close`/`input` messages, pane split trees.
- React Flow node positions, drag, resize, viewport, zoom, pan, minimap, context edges, spawn geometry.
- Node data shape, workspace persistence shape, server APIs, settings keys.
- Existing localStorage keys: `webterm.sessionsPinned`, `webterm.sessionsCollapsed`, `webterm.chatOpen`, `webterm.chatConversation`.
- Approval safety: literal `APPROVE`, irreversible-action checkbox, server nonce and digest.

Not frozen, but requires explicit product confirmation before implementation:
- Moving workspace tabs from the current 46px header into a 35px editor tab strip.
- Introducing node tabs. This is new behavior, not a visual reskin.
- Turning Inbox and Chat from two floating cards into two tabs of one bottom panel.
- Turning Settings from a full-screen modal into an editor-area view.
- Replacing the warm light palette with VS Code Light Modern.

---

## 1. VS Code design spec

All dimensions below are taken from VS Code source or from the shipped elements package, not invented.

### 1.1 Layout metrics

| Region | Metric | Source / note |
|---|---|---|
| Custom title bar | 35px height | `DEFAULT_CUSTOM_TITLEBAR_HEIGHT = 35` in VS Code `window.ts` |
| Menu bar row | 35px, inside title bar | Items `padding: 0 8px`, font 13px |
| Activity bar | 48px wide | `ACTIVITYBAR_WIDTH = 48` |
| Activity bar item | 48x48px, icon 24px | `ACTION_HEIGHT = 48` |
| Activity bar active indicator | 2px left border, `#0078D4` dark / `#005FB8` light | `activityBar.activeBorder` |
| Sidebar | 300px preferred, 170px minimum | `sidebarPart.ts` `preferredWidth` / `minimumWidth` |
| Sidebar view title | 35px | VS Code view title height |
| Sidebar section header | 22px, 11px uppercase, letter-spacing 0.04em | VS Code pane header |
| Tree row | 22px, 13px, indent 8px | `vscode-tree-item` ships 22px |
| Editor tab strip | 35px total | `EDITOR_TAB_HEIGHT.normal = 35` |
| Editor tab | 35px, padding 0 10px, 13px, close icon 16px | Active top border 1px accent |
| Editor breadcrumbs | 22px, 12px | VS Code breadcrumbs |
| Panel title row | 35px, tabs 13px, active top border 1px accent | `panelTitle.activeBorder` |
| Panel | Default 40 percent of editor area, minimum 77px, sash 4px | `panelPart.ts` |
| Status bar | 22px, 12px, item padding 0 5px | `StatusbarPart.HEIGHT = 22` |
| Menu row | 22px, min-width 160px, padding 2px 26px 2px 2px | Context menu |
| Quick pick | 600px wide, top 6px below title bar, max list 20 x 22px = 440px | `quickInput.css` width 600px |
| Text input | 24px height, 13px, padding 0 6px, radius 2px | `vscode-textfield` 24px |
| Button | 24px minimum height, 13px, padding 1px 13px, radius 2px | `vscode-button` min-height 24px |
| Toolbar button | 22x22px, icon 16px, radius 5px | `vscode-toolbar-button` height 22px |
| Badge | 16px height, 9px font, radius 10px | Activity bar badge |
| Checkbox | 16x16px, radius 3px | VS Code checkbox |
| Toggle / switch | 36x20px track, 16px thumb | `vscode-checkbox toggle` |
| Scrollbar | 14px wide, 10px thumb, min thumb 20px, radius 5px | VS Code scrollbar |
| Notification toast | max-width 400px, bottom 3px above status bar, header 35px | VS Code notifications |
| Dialog | 480px default width, 20px padding, 16px semibold title, 13px body | webterm custom, VS Code modal proportions |

### 1.2 Core layout result

```text
+--------------------------------------------------------------+
| Title bar 35px: menu bar, brand, command center, window action|
+------+-------------------------------------------------------+
|      | Editor tab strip 35px: workspace tabs, node tabs       |
| Act. +-------------+-----------------------------------------+
| 48px | Sidebar     | Editor area                             |
|      | 300px       | Canvas (React Flow)                     |
|      | resizable   |                                         |
|      |             +-----------------------------------------+
|      |             | Bottom panel: Inbox / Chat, 40%, min 77 |
+------+-------------+-----------------------------------------+
| Status bar 22px                                              |
+--------------------------------------------------------------+
```

CSS grid contract:

```css
.app-shell {
  display: grid;
  grid-template-rows: var(--title-bar-h) var(--editor-tabs-h) minmax(0, 1fr) var(--status-bar-h);
  grid-template-columns: var(--activity-bar-w) var(--sidebar-w) minmax(0, 1fr);
  grid-template-areas:
    "title title title"
    "editor-tabs editor-tabs editor-tabs"
    "activity sidebar editor"
    "status status status";
  height: 100vh;
  width: 100vw;
}
```

The editor region is its own vertical grid: canvas `minmax(0, 1fr)` and bottom panel height. The canvas cell must set `position: relative; min-height: 0; min-width: 0`. React Flow needs a definite height, so no `height: auto` anywhere on that path.

### 1.3 Color tokens: Dark Modern and Light Modern

Use the VS Code theme files as the source of truth. The values below are copied from `dark_modern.json` and `light_modern.json`, plus the VS Code color-registry defaults where the theme file is silent.

| `--vscode-*` token | Dark Modern | Light Modern |
|---|---|---|
| `editor-background` | `#1F1F1F` | `#FFFFFF` |
| `editor-foreground` | `#CCCCCC` | `#3B3B3B` |
| `foreground` | `#CCCCCC` | `#3B3B3B` |
| `descriptionForeground` | `#9D9D9D` | `#3B3B3B` |
| `disabledForeground` | `#CCCCCC80` | `#3B3B3B80` |
| `focusBorder` | `#0078D4` | `#005FB8` |
| `titleBar-activeBackground` | `#181818` | `#F8F8F8` |
| `titleBar-activeForeground` | `#CCCCCC` | `#1E1E1E` |
| `titleBar-border` | `#2B2B2B` | `#E5E5E5` |
| `activityBar-background` | `#181818` | `#F8F8F8` |
| `activityBar-foreground` | `#D7D7D7` | `#1F1F1F` |
| `activityBar-inactiveForeground` | `#868686` | `#616161` |
| `activityBar-activeBorder` | `#0078D4` | `#005FB8` |
| `activityBar-border` | `#2B2B2B` | `#E5E5E5` |
| `activityBarBadge-background` | `#0078D4` | `#005FB8` |
| `activityBarBadge-foreground` | `#FFFFFF` | `#FFFFFF` |
| `sideBar-background` | `#181818` | `#F8F8F8` |
| `sideBar-foreground` | `#CCCCCC` | `#3B3B3B` |
| `sideBar-border` | `#2B2B2B` | `#E5E5E5` |
| `sideBarSectionHeader-background` | `#181818` | `#F8F8F8` |
| `sideBarSectionHeader-foreground` | `#CCCCCC` | `#3B3B3B` |
| `editorGroupHeader-tabsBackground` | `#181818` | `#F8F8F8` |
| `editorGroupHeader-tabsBorder` | `#2B2B2B` | `#E5E5E5` |
| `tab-activeBackground` | `#1F1F1F` | `#FFFFFF` |
| `tab-activeForeground` | `#FFFFFF` | `#3B3B3B` |
| `tab-activeBorderTop` | `#0078D4` | `#005FB8` |
| `tab-inactiveBackground` | `#181818` | `#F8F8F8` |
| `tab-inactiveForeground` | `#9D9D9D` | `#616161` |
| `tab-border` | `#2B2B2B` | `#E5E5E5` |
| `tab-hoverBackground` | `#1F1F1F` | `#FFFFFF` |
| `panel-background` | `#181818` | `#F8F8F8` |
| `panel-border` | `#2B2B2B` | `#E5E5E5` |
| `panelTitle-activeBorder` | `#0078D4` | `#005FB8` |
| `panelTitle-activeForeground` | `#CCCCCC` | `#3B3B3B` |
| `panelTitle-inactiveForeground` | `#9D9D9D` | `#3B3B3B` |
| `statusBar-background` | `#181818` | `#F8F8F8` |
| `statusBar-foreground` | `#CCCCCC` | `#3B3B3B` |
| `statusBar-border` | `#2B2B2B` | `#E5E5E5` |
| `statusBarItem-hoverBackground` | `#F1F1F133` | `#1F1F1F11` |
| `statusBarItem-remoteBackground` | `#0078D4` | `#005FB8` |
| `menu-background` | `#1F1F1F` | `#FFFFFF` |
| `menu-foreground` | `#CCCCCC` | `#3B3B3B` |
| `menu-border` | `#454545` | `#CECECE` |
| `menu-selectionBackground` | `#0078D4` | `#005FB8` |
| `menu-selectionForeground` | `#FFFFFF` | `#FFFFFF` |
| `menu-separatorBackground` | `#454545` | `#E5E5E5` |
| `quickInput-background` | `#222222` | `#F8F8F8` |
| `quickInput-foreground` | `#CCCCCC` | `#3B3B3B` |
| `input-background` | `#313131` | `#FFFFFF` |
| `input-foreground` | `#CCCCCC` | `#3B3B3B` |
| `input-border` | `#3C3C3C` | `#CECECE` |
| `input-placeholderForeground` | `#989898` | `#767676` |
| `inputOption-activeBackground` | `#2489DB82` | `#BED6ED` |
| `inputOption-activeBorder` | `#2488DB` | `#005FB8` |
| `button-background` | `#0078D4` | `#005FB8` |
| `button-foreground` | `#FFFFFF` | `#FFFFFF` |
| `button-hoverBackground` | `#026EC1` | `#0258A8` |
| `button-secondaryBackground` | `#00000000` | `#E5E5E5` |
| `button-secondaryForeground` | `#CCCCCC` | `#3B3B3B` |
| `button-secondaryHoverBackground` | `#2B2B2B` | `#CCCCCC` |
| `checkbox-background` | `#313131` | `#F8F8F8` |
| `checkbox-border` | `#3C3C3C` | `#CECECE` |
| `list-activeSelectionBackground` | `#094771` | `#E8E8E8` |
| `list-activeSelectionForeground` | `#FFFFFF` | `#000000` |
| `list-hoverBackground` | `#2A2D2E` | `#F2F2F2` |
| `list-focusAndSelectionOutline` | `#0078D4` | `#005FB8` |
| `scrollbarSlider-background` | `#79797966` | `#64646466` |
| `scrollbarSlider-hoverBackground` | `#646464B3` | `#64646499` |
| `scrollbarSlider-activeBackground` | `#BFBFBF66` | `#BFBFBF66` |
| `widget-shadow` | `#0000005C` | `#00000029` |
| `editorWidget-background` | `#202020` | `#F8F8F8` |
| `editorWidget-border` | `#313131` | `#E5E5E5` |
| `notifications-background` | `#1F1F1F` | `#FFFFFF` |
| `notifications-border` | `#2B2B2B` | `#E5E5E5` |
| `badge-background` | `#616161` | `#CCCCCC` |
| `badge-foreground` | `#F8F8F8` | `#3B3B3B` |

Canvas decision: use `--vscode-editor-background` for the canvas plane and `#2B2B2B` dark / `#E5E5E5` light for dots. This is the closest VS Code-like reading. The current pure black canvas and warm light canvas are not VS Code-like. Keep the option to restore `--canvas-bg` as an explicit product override.

Node decision: keep node identity colors and status glows. Change only the neutral surfaces to VS Code panel values:
- node body `--vscode-editorWidget-background` (`#202020` dark, `#F8F8F8` light)
- node header `#252526` dark, `#F3F3F3` light
- node border `#2B2B2B` dark, `#E5E5E5` light
- node selected border `--vscode-focusBorder`

### 1.4 Typography

| Role | Spec |
|---|---|
| UI font stack | `-apple-system, BlinkMacSystemFont, "Segoe UI", "Ubuntu", "Droid Sans", sans-serif` |
| UI base size | 13px, weight 400, line-height 1.4 |
| Title bar | 13px |
| Menu bar | 13px |
| Editor tabs | 13px, active weight 400, inactive 400 |
| Sidebar title | 13px, weight 400 (VS Code view title does not bold) |
| Section header | 11px, uppercase, letter-spacing 0.04em |
| Tree row | 13px, 22px row |
| Status bar | 12px |
| Menu | 13px |
| Quick pick | 13px |
| Input and button | 13px |
| Dialog title | 16px, weight 600 |
| Dialog body | 13px |
| Badge | 9px, weight 600, tabular numbers |
| Code and monospace | `Menlo, Monaco, "Courier New", monospace` |
| Terminal and editor | keep user settings and existing terminal themes |

Do not keep the current 12.5px sidebar and node header sizes for shell surfaces. Use 13px for all shell text. A 0.5px difference is visible when placed next to a VS Code window.

### 1.5 Shape, elevation, motion

- Corner radius: 2px for inputs, buttons, menus, tabs; 4px for cards and widgets; 6px for floating panels; 999px only for badges and status pills. VS Code does not use 8 to 16px rounded corners for chrome. The current dock uses 16px and nodes use 10px. Keep node radius 10px as a webterm identity, but shell chrome must drop to 2 to 6px.
- Shadows: menus and quick pick use `0 8px 24px rgba(0,0,0,0.36)` dark, `0 8px 24px rgba(0,0,0,0.16)` light. Panels and sidebar use no shadow, only 1px borders.
- Hover transitions: 100ms ease-out on background and color. No scale transforms on toolbar buttons.
- Quick pick open: 250ms `cubic-bezier(0.22, 1, 0.36, 1)`, opacity and 0.97 scale. Close 150ms.
- Respect `prefers-reduced-motion: reduce`: no scale, no slide, keep opacity only.
- Do not animate canvas node glow as part of this migration. Existing status glow animations stay as they are.

### 1.6 Focus, hover, selection, scrollbar

| State | Spec |
|---|---|
| Keyboard focus | 1px solid `--vscode-focusBorder`, outline-offset `-1px` on inputs and list rows, `2px` on buttons if the outline would be clipped |
| List hover | background `--vscode-list-hoverBackground`, no text color change |
| List active selection | background `--vscode-list-activeSelectionBackground`, foreground `--vscode-list-activeSelectionForeground` |
| Tab hover | `--vscode-tab-hoverBackground`, inactive foreground stays muted |
| Tab active | top border 1px `--vscode-tab-activeBorderTop`, background `--vscode-tab-activeBackground`, foreground active |
| Activity bar active | left border 2px accent, icon active foreground, `aria-current="page"` |
| Panel tab active | top border 1px accent, active foreground |
| Status bar item hover | `--vscode-statusBarItem-hoverBackground`, foreground `--vscode-statusBarItem-hoverForeground` |
| Scrollbar | track transparent, thumb 10px with 2px inset, radius 5px, min height 20px, hover and active tokens above |
| Disabled | opacity 0.4, cursor not-allowed, no hover background |
| Focus visible only | use `:focus-visible`, never a permanent outline on mouse click |

### 1.7 Token bridge and migration strategy

Two phases, both inside lane 1.

Phase A, bridge only, low risk:

```css
/* src/client/vscodeTheme.css, loaded after styles.css */
:root {
  --vscode-font-family: var(--font-ui);
  --vscode-font-size: 13px;
  --vscode-font-weight: 400;
  --vscode-foreground: var(--text);
  --vscode-descriptionForeground: var(--muted);
  --vscode-focusBorder: var(--accent);
  --vscode-editor-background: var(--canvas-bg);
  --vscode-sideBar-background: var(--panel);
  --vscode-menu-background: var(--overlay);
  --vscode-menu-border: var(--border);
  --vscode-menu-foreground: var(--text);
  --vscode-menu-selectionBackground: var(--accent);
  --vscode-menu-selectionForeground: #fff;
  --vscode-panel-background: var(--panel);
  --vscode-panel-border: var(--border);
  --vscode-input-background: var(--sunken);
  --vscode-input-foreground: var(--text);
  --vscode-input-border: var(--border);
  --vscode-button-background: var(--accent);
  --vscode-button-hoverBackground: var(--accent-hover);
  --vscode-button-foreground: #fff;
  --vscode-list-hoverBackground: rgba(var(--tint-rgb), 0.06);
  --vscode-list-activeSelectionBackground: rgba(var(--accent), 0.18);
  --vscode-scrollbarSlider-background: rgba(var(--tint-rgb), 0.3);
}
```

Phase A lets every VS Code Element render immediately without changing the current palette. It also proves the layout and interaction before the visual change.

Phase B, exact VS Code palette, scoped by `html[data-ui='vscode']`:

- Add the exact dark and light token blocks from section 1.3 under `:root[data-theme='dark'][data-ui='vscode']` and `:root[data-theme='light'][data-ui='vscode']`.
- Remap the legacy aliases for shell surfaces only:
  - `--panel` becomes `--vscode-sideBar-background`.
  - `--panel-header` becomes `--vscode-menu-background`.
  - `--overlay` becomes `--vscode-menu-background`.
  - `--accent` becomes `--vscode-button-background`.
  - `--border` becomes `--vscode-panel-border`.
  - `--muted` becomes `--vscode-descriptionForeground`.
- Introduce new node-specific variables so nodes do not accidentally inherit shell values:
  - `--node-bg: var(--vscode-editorWidget-background)`
  - `--node-header: var(--vscode-menu-background)`
  - `--node-border: var(--vscode-panel-border)`
- Keep `--canvas-bg` as an override hook. Default it to `--vscode-editor-background`.
- Keep `--tint-rgb` only for canvas and node overlays, not for shell chrome.
- Remove `html[data-ui='vscode']` after lane 8. The flag is a migration tool, not a permanent setting.

Important: `--vscode-*` custom properties inherit into shadow DOM. That is the only sanctioned way to theme the web components. Do not attempt `vscode-tabs .header` or `::vscode-...` selectors.

### 1.8 Keyboard contract

| Shortcut | Action | Note |
|---|---|---|
| `Cmd/Ctrl+K` | Open command palette | Existing shortcut, expands from node search to global commands |
| `Cmd/Ctrl+Shift+P` | Open command palette | VS Code primary shortcut |
| `Cmd/Ctrl+B` | Toggle sidebar | VS Code |
| `Cmd/Ctrl+J` | Toggle bottom panel | VS Code |
| `Cmd/Ctrl+,` | Open settings | VS Code |
| `Ctrl+Tab` | Next node tab | New behavior, requires confirmation |
| `Ctrl+Shift+Tab` | Previous node tab | New behavior, requires confirmation |
| `F1` | Help / command palette | Optional |
| `Escape` | Close the topmost layer | Command palette > menu > popover > tooltip > panel > dialog, strict stack |
| `ArrowUp/Down` | Move active row | Quick pick, menu, tree |
| `ArrowLeft/Right` | Collapse/expand or switch menu | Tree and menu bar |
| `Enter/Space` | Activate active row | Menu, tree, quick pick |
| `Home/End` | First/last row | Menu, quick pick |
| type-ahead | Jump to matching menu or tree row | 500ms buffer |
| `Cmd/Ctrl+S` | Save focused editor | Unchanged |
| `Cmd/Ctrl+M` | Toggle Markdown preview | Unchanged |
| `Cmd/Ctrl+.` | Exit clean view | Unchanged |

Do not hijack `Cmd/Ctrl+W`, browser close, or terminal chords that the terminal currently owns. Respect the existing `terminalShortcutPolicy` setting.

### 1.9 Z-index contract

| Layer | z-index |
|---|---|
| Canvas and nodes | 0 to 5 |
| Sidebar and docked panel | 10 to 19 |
| Shell title, tabs, status | 20 to 29 |
| Editor toolbar and floating find | 30 to 39 |
| Sidebar overlay on narrow screens | 40 |
| Menus and context menus | 1000 |
| Dialogs and approval | 1100 |
| Quick pick and command palette | 1200 |
| Notifications | 1300 |
| Tooltips | 1400 |

Portal all overlays to `document.body`. React Flow wraps nodes in a transformed container, so a `position: fixed` child inside a node is positioned relative to the canvas transform, not the viewport. This is already handled by `NodeContextMenu` and must remain true for the new menu, tooltip, and popover.

---

## 2. Surface inventory

Complexity: S under 1 day, M 1 to 2 days, L 3 to 5 days, XL over 5 days.
Risk names are behavior suites or contracts that must be re-run.

| # | Surface / file | Current primitive | Target | C | Risk | Lane |
|---|---|---|---|---|---|---|
| 1 | App shell `App.tsx` (460) | `div.app-shell` flex column, floating absolute panels | CSS grid shell, named slots, panel dock | L | boot, workspace lifecycle, viewport, all tests | 2 |
| 2 | Title bar `WorkspaceBar.tsx` (321) | `header.tabbar`, shadcn `Tabs`, `Input`, `Button`, custom `NodeContextMenu` | 35px `TitleBar` + 35px `EditorTabBar` + `MenuBar` + command center | XL | workspace switch, rename, delete, overflow, tabs | 2 |
| 3 | Workspace tabs `WorkspaceBar.tsx` | shadcn `Tabs` with `variant="line"`, custom `.tab` CSS | Custom `EditorTabBar`: top border active, closable, dirty/status dot, overflow fade | L | `workspaceTabs`, rename inline, kebab menu, scroll reveal | 2 |
| 4 | Activity bar / dock `Dock.tsx` (288), `dock.css` | Floating 38px button rail, shadcn `Button`, `Separator`, dialogs | 48px `ActivityBar` with badge, top and bottom groups, tooltips; canvas actions move to editor toolbar and status bar | L | `dockSessions`, `dockMerge`, add/undo/zoom/lock/clean-view parity | 2 |
| 5 | Canvas controls `CanvasToolbar.tsx` (249), `canvas-ui.css` | Floating `.controls-cluster`, shadcn `Dialog` + `Command` | `VscodeToolbarContainer` at editor top-right, 22px buttons, command palette separate | M | palette ranking, Cmd+K, settings/help entry | 6 |
| 6 | Command palette `CanvasToolbar.tsx` | shadcn `Dialog` + `cmdk` `Command` | Custom `QuickPick`, 600px, 24px input, 22px rows, global commands | L | keyboard, focus, node search, command dispatch | 6 |
| 7 | Sidebar Sessions `SessionsPanel.tsx` (466) | shadcn `Card`, `Tabs`, `Input`, `ScrollArea`, custom rows | 300px `Sidebar`, 35px view title, `VscodeTree`, 22px rows | XL | `sessionsPanelOpen`, grouping, filter, collapse, recently closed | 3 |
| 8 | Session row `SessionRow.tsx` (106) | `div role=button`, custom glyphs | `VscodeTreeItem` with slotted icon, description, actions, decoration | M | row focus, middle click, close, unread glyph | 3 |
| 9 | Inbox panel `InboxPanel.tsx` (369) | shadcn `Card`, `ScrollArea`; floating | Bottom panel tab, `VscodeTabs` panel variant, custom 22px list | L | `InboxPanel.test`, recovery, fence, poll, badge | 4 |
| 10 | Inbox chrome `inboxPanelChrome.tsx` (154) | shadcn `Tabs`, `Button` | Panel title actions and filter row | M | filter counts, refresh, bulk toolbar | 4 |
| 11 | Inbox sections `inboxPanelSections.tsx` (77) | custom sections, shadcn `Checkbox` | `VscodeCollapsible` sections, `VscodeCheckbox` | M | select-all, collapse, empty state | 4 |
| 12 | Inbox item `inboxItemRow.tsx` (65) | custom row, shadcn `Checkbox` | 22px VS Code list row, badge, action | S | selection, review action | 4 |
| 13 | Approval dialog `inboxApprovalDialog.tsx` (222) | shadcn `AlertDialog`, `Checkbox`, `Input` | Custom VS Code modal, native checkbox, literal `APPROVE` | M | consent, focus trap, pending, expiry, no accidental approve | 4 |
| 14 | Inbox dialog shell `inboxPanelDialog.tsx` (54) | custom dialog state | VS Code modal shell | S | dialog keys, Escape, focus restore | 4 |
| 15 | Chat panel `ChatPanel.tsx` (192) | shadcn `Card`, floating | Bottom panel tab, `VscodeTabs` panel variant | L | `ChatPanel.test`, conversation list, errors | 4 |
| 16 | Chat conversation `chat/chatConversation.tsx` (191) | custom header, status dot | VS Code panel content, 13px, 35px subheader | M | stream, reconnect, stop, 409 busy | 4 |
| 17 | Chat messages `chat/chatMessages.tsx` (168) | custom markdown | VS Code markdown body, code block `#2B2B2B` | M | markdown, tool cards, streaming | 4 |
| 18 | Chat composer `chat/chatComposer.tsx` (65) | shadcn `Textarea`, `Button` | VS Code textarea + 24px button | S | Enter/Shift+Enter, IME composition | 4 |
| 19 | Status bar | absent | New 22px `StatusBar` with left and right items | M | new state wiring, aria-live | 2 |
| 20 | Settings `SettingsPanel.tsx` (223) | full-screen shadcn `Dialog`, shadcn `Button` nav | VS Code settings editor: 35px title, 200px nav, checkboxes | L | settings persistence, keyboard, section switching | 5 |
| 21 | Settings fields `SettingsFields.tsx` (204) | shadcn `Input`, `Select`, `Switch`, `Label` | `VscodeTextfield`, `VscodeSingleSelect`, `VscodeCheckbox`, 24px rows | L | number clamp, hex color, select values | 5 |
| 22 | Settings agents `SettingsAgents.tsx` (228) | shadcn `Card`, `Input`, `Button` | VS Code settings cards, 22px rows, native inputs | M | custom agents, launch commands, disabled agents | 5 |
| 23 | Folder picker `FolderPicker.tsx` (69) | shadcn `Dialog`, `ScrollArea` | VS Code modal + `VscodeTree` or quick pick | M | up navigation, path truncation, select | 5 |
| 24 | Help `HelpOverlay.tsx` (54) | shadcn `Dialog`, `ScrollArea` | VS Code Keyboard Shortcuts view or 480px modal | S | Escape, focus restore, shortcut accuracy | 5 |
| 25 | Welcome `Welcome.tsx` (132) | custom cards, shadcn `Button`, `Input`, `Label` | VS Code Welcome page: 35px tab, recent list, 13px | M | welcome and create project | 5 |
| 26 | Login `Login.tsx` (74) | custom card, shadcn inputs | VS Code auth page or 480px modal | M | `Login.test`, token validation, error | 5 |
| 27 | Add dialog `Dock.tsx` | shadcn `Dialog` list | VS Code quick pick or 480px modal with 22px rows | M | agent list, custom agents, workspace form | 2 |
| 28 | Zoom dialog `Dock.tsx` | shadcn `Dialog` list | VS Code quick pick / menu | S | presets, current check | 2 |
| 29 | Workspace dialog `Dock.tsx` | shadcn `Dialog` + `Input` | VS Code modal, 24px inputs, browse | S | create workspace, cwd picker | 2 |
| 30 | Node chrome `NodeChrome.tsx` (170) | custom `.node-header`, shadcn `Badge`, `Input` | 28px node header, codicon toolbar, VS Code title field | L | rename, collapse, color, comments, pane split | 7 |
| 31 | Node toolbar `NodeToolbar.tsx` (90) | custom SVG icons, shadcn `Button` | `VscodeToolbarContainer` + 22px `VscodeToolbarButton` | M | refresh, search, mic, comments, broadcast, close | 7 |
| 32 | Node color `NodeColorSwatch.tsx` (37) | custom popover spans | VS Code color picker popover, 8 swatches | S | color selection, outside click | 7 |
| 33 | Node comments `NodeComments.tsx` (58) | custom list, shadcn `Textarea` | VS Code comment thread, 13px | M | add comment, Enter, empty state | 7 |
| 34 | Terminal node `TerminalNode.tsx` (234) | `NodeChrome` + xterm + pane tree | Keep xterm and panes, restyle chrome only | L | `terminalCore`, pane split, menu, clipboard | 7 |
| 35 | Agent node `AgentNode.tsx` (290) | `NodeChrome` + status + usage | Keep agent behavior, restyle chrome only | L | status, resume, session id, unread | 7 |
| 36 | Editor node `EditorNode.tsx` (367) | Monaco `vs-dark`, custom header | Monaco `vs-dark` / `vs`, 35px tab, 22px breadcrumbs, dirty dot | L | editor save, preview, file open edge | 7 |
| 37 | Files node `FilesNode.tsx` (310) | custom file list, breadcrumb | VS Code Explorer tree: 22px rows, codicons, breadcrumb | XL | file browse, open, keys, context menu, node drag | 7 |
| 38 | Find bar `FindBar.tsx` (25) | custom floating input | VS Code find widget: 24px input, 22px buttons | S | search next/prev, Escape | 7 |
| 39 | Usage pill `UsagePill.tsx` (65) | shadcn `Badge` | `VscodeBadge` + 4px progress bar | S | percent, level colors | 7 |
| 40 | Kanban `Kanban.tsx` (77) | shadcn `Card` overlay | VS Code editor overlay or panel view | M | grouping, focus, close, Escape | 4 |
| 41 | Node context menu `NodeContextMenu.tsx` (92) | custom portal, shadcn `Separator` | Custom VS Code `Menu` with icons, keybindings, submenu, danger | L | all node menus, viewport placement | 6 |
| 42 | Canvas menu `CanvasContextMenu.tsx` (213) | custom panel + keyboard | Same `Menu` primitive with submenu geometry | L | `canvasContextMenu`, spawn spot, agent submenu | 6 |
| 43 | Canvas menu row `CanvasMenuRow.tsx` (148) | custom row with icons | `Menu` row, 22px, 13px, caret, dot | M | aria-disabled, hover, submenu side | 6 |
| 44 | Canvas menu pane `canvasMenu.pane.tsx` (91) | custom pane | `Menu` pane, focus, type-ahead | M | pane menu keyboard, backdrop | 6 |
| 45 | Clean view `cleanView.tsx` (73), `cleanView.css` | body class hides `.tabbar`, `.dock`, panels | body class hides new shell, keeps canvas and node headers | S | clean view tests, chord exit | 2 |
| 46 | Tooltips and popovers `components/ui/tooltip.tsx`, `popover.tsx` | shadcn Radix | Custom VS Code tooltip and popover, 500ms delay, shadow, flip | M | hover behavior, focus, Escape | 1 |
| 47 | Dialog and sheet `components/ui/dialog.tsx`, `sheet.tsx` | shadcn Radix | Custom VS Code modal and docked panel | L | focus trap, Escape, backdrop, `aria-modal` | 1 |
| 48 | Switch / checkbox / card / badge `components/ui/*` | shadcn | VS Code variants or `VscodeCheckbox`, `VscodeBadge` | M | settings, inbox, node status | 1 |
| 49 | Tests `src/client/*.test.tsx` (19 files) | RTL roles and labels, DOM classes | Update selectors, add shadow-DOM helpers, add shell tests | L | every existing suite | 8 |
| 50 | CSS sheets (13 files, 2,405 lines) | `styles.css`, per-surface sheets | `vscodeTheme.css`, `shell.css`, surface sheets, remove dead CSS | L | visual regressions, cascade order | 1, 8 |

---

## 3. Missing components

### 3.1 Component matrix

| Component | Exists in VS Code Elements | Decision | Used by |
|---|---|---|---|
| Dialog / modal | No | Build native custom | Approval, Add, Zoom, Workspace, Login, Help, FolderPicker |
| Sheet / docked panel | No | Build `Panel` with 35px title and 4px sash | Bottom Inbox/Chat panel |
| Popover | No | Build custom anchored popover | Color picker, node actions, inline menus |
| Dropdown menu / context menu | Flat menu only | Build full `Menu` with submenus, icons, keybindings, disabled, danger | Node, canvas, workspace, menu bar |
| Tooltip | No | Build custom | Activity bar, toolbar, status bar |
| Card | No | Build VS Code `Card` (1px border, 4px radius) | Settings, Welcome, Kanban |
| Switch | `VscodeCheckbox` with `toggle` | Wrap as `Switch`, use `VscodeCheckbox toggle` | Settings booleans, lock view |
| Command palette | No | Build `QuickPick` | Global commands, node search, workspace switch |
| Status bar | No | Build `StatusBar` | Always visible bottom row |
| Activity bar | No | Build `ActivityBar` | Left rail |
| Menu bar | No | Build `MenuBar` | Title bar |
| Split view | `VscodeSplitLayout` | Wrap, use for bottom panel if it passes integration proof | Bottom panel resize |
| Notification / toast | No | Build `NotificationCenter` | Errors, save failures, reconnect |
| Editor tab strip | `VscodeTabs` is panel-style only | Build `EditorTabBar` | Workspace tabs, node tabs |
| Breadcrumbs | No | Build `Breadcrumbs` | Editor and Files node |
| Find widget | No | Build `FindWidget` | Terminal and editor search |
| File tree row | `VscodeTreeItem` | Use `VscodeTree` for Files, if canvas event isolation passes | Files node |

### 3.2 Required API and behavior

#### Dialog

```ts
interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  width?: number
  dismissible?: boolean
  initialFocus?: React.RefObject<HTMLElement>
  children: React.ReactNode
  footer?: React.ReactNode
}
```

Behavior:
- Renders a portal at `document.body`, z-index 1100.
- `role="dialog"`, `aria-modal="true"`, labelled by title, described by description when present.
- Focus trap: first focusable or `initialFocus`, wrap Tab and Shift+Tab, restore focus to the trigger on close.
- Escape closes only when `dismissible` is true and no inner dialog is open.
- Backdrop click closes only when `dismissible` is true.
- Body scroll lock while open, but never lock the canvas container if the dialog is node-local. Prefer `overflow: hidden` on the shell root, not `body`, to avoid xterm resize.
- Header 35px, title 16px weight 600, body 13px, padding 20px, footer buttons right aligned.

#### Panel / Sheet

```ts
interface PanelProps {
  open: boolean
  activeTab: string
  onTabChange: (id: string) => void
  tabs: { id: string; label: string; badge?: number }[]
  actions?: React.ReactNode
  height: number
  minHeight?: number
  maxHeight?: number
  onHeightChange: (height: number) => void
  children: React.ReactNode
}
```

Behavior:
- 35px title row, tabs left, actions right. Active tab has top border 1px accent.
- 4px sash at the top edge, `role="separator"`, `aria-orientation="horizontal"`, keyboard resize with ArrowUp/ArrowDown in 10px steps, Shift for 50px, Home/End for min/max.
- Non-modal: focus is not trapped. Escape closes only when focus is inside the panel.
- Height persists per browser under `webterm.panelHeight`. Default 40 percent of editor area, clamp to 77px minimum and 80 percent maximum.
- Content scrolls with VS Code scrollbar. Canvas does not resize until the drag ends? React Flow should observe the resize during drag; test for jitter. If jitter appears, throttle `onHeightChange` to animation frames.

#### Popover

```ts
interface PopoverProps {
  anchor: DOMRect | HTMLElement
  open: boolean
  onOpenChange: (open: boolean) => void
  placement?: 'top' | 'bottom' | 'left' | 'right'
  offset?: number
  children: React.ReactNode
}
```

Behavior:
- Flip and shift to stay inside the viewport with 8px margin.
- `role="dialog"` when interactive, `role="tooltip"` only for non-interactive hints.
- Outside pointerdown closes. Escape closes and restores focus. Focus moves into the popover on open when it contains focusable content.
- Uses the menu background, border, shadow, and 4px radius.

#### Menu / DropdownMenu / ContextMenu

```ts
type MenuItem =
  | { type: 'item'; id: string; label: string; icon?: ReactNode; keybinding?: string; disabled?: boolean; danger?: boolean; checked?: boolean; submenu?: MenuItem[]; onSelect: () => void }
  | { type: 'separator' }
  | { type: 'header'; label: string }

interface MenuProps {
  open: boolean
  anchor: { x: number; y: number }
  items: MenuItem[]
  onClose: () => void
  minWidth?: number
  ariaLabel?: string
}
```

Behavior:
- Portal to body, z-index 1000. Viewport flip and shift. Submenus open right, flip left when they do not fit, overlap the parent by 4px so the pointer never crosses a gap.
- Rows 22px, 13px, icon 16px, keybinding right aligned in muted color, separator 1px.
- Roving focus. ArrowDown/ArrowUp move, Home/End jump, ArrowRight opens submenu, ArrowLeft closes submenu, Enter/Space activate, Escape closes one level.
- Type-ahead selects the first row starting with the typed characters.
- Disabled rows use `aria-disabled="true"`, remain focusable and readable, and do not activate.
- Danger rows use `--vscode-errorForeground` (`#F85149` dark, `#C72E0F` light) only for text and icon, not a filled red background.
- `aria-haspopup="menu"`, `aria-expanded`, `aria-controls`, `aria-activedescendant` or roving `tabIndex`.
- Menu bar: 35px row, labels 13px, hover opens, ArrowLeft/ArrowRight switch top-level menus, ArrowDown opens, Escape closes. Mnemonics optional but recommended.

#### Tooltip

```ts
interface TooltipProps {
  content: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  delayMs?: number // default 500, VS Code hover delay
  children: React.ReactElement
}
```

Behavior:
- 500ms show delay, 100ms hide delay. No delay when the user focuses with the keyboard.
- 13px, max-width 500px, padding 4px 8px, background `--vscode-editorWidget-background`, border `--vscode-editorWidget-border`, radius 2px, shadow.
- `aria-describedby` on the trigger. Escape dismisses. Hovering the tooltip keeps it open.
- Do not show a tooltip for a control that already has a visible text label unless the tooltip adds a shortcut.

#### Card

```ts
interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'tile'
}
```

- 1px border, 4px radius, background `--vscode-editorWidget-background`, no shadow, padding 12px.
- `tile` is for Welcome and Kanban: `#2B2B2B` dark / `#F3F3F3` light background, hover border accent.

#### Switch

```ts
interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}
```

- Prefer `VscodeCheckbox` with `toggle` attribute. Track 36x20, thumb 16, radius 999px, background `--vscode-checkbox-background`, checked background `--vscode-button-background`, focus ring `--vscode-focusBorder`.
- Settings booleans should use a plain checkbox, not a switch, because VS Code settings use checkboxes. A switch is only for a live toolbar state such as view lock, and even there a toolbar toggle button is more VS Code-like.

#### QuickPick / Command palette

```ts
interface QuickPickItem {
  id: string
  label: string
  description?: string
  detail?: string
  keybinding?: string
  icon?: ReactNode
  group?: string
  disabled?: boolean
}

interface QuickPickProps {
  open: boolean
  onClose: () => void
  placeholder: string
  items: QuickPickItem[]
  onSelect: (id: string) => void
  rank?: (item: QuickPickItem, query: string) => number | null
  emptyText?: string
}
```

Behavior:
- 600px wide, centered, top 6px below the title bar, max height 440px list, 24px input, 22px rows.
- Fuzzy ranking: word-start substring, substring, description substring, subsequence. Reuse `targetScore` and `rankTargets` from `CanvasToolbar.tsx`, do not duplicate.
- Group headings 11px uppercase, sticky.
- `aria-activedescendant` on the input, `role="listbox"`, `role="option"`.
- ArrowDown/ArrowUp move, Enter selects, Escape closes, no wrap at ends.
- Query text is preserved per session while open, cleared on close.
- Palette opens on `Cmd/Ctrl+K` and `Cmd/Ctrl+Shift+P`. It must not steal keys from the terminal when `terminalShortcutPolicy` is `terminal-first` and the terminal has focus, except for the explicit palette chord.

#### StatusBar

```ts
interface StatusBarProps {
  left: StatusItem[]
  right: StatusItem[]
}

interface StatusItem {
  id: string
  label: string
  icon?: ReactNode
  tooltip?: string
  onClick?: () => void
  tone?: 'default' | 'remote' | 'warning' | 'error'
  ariaLabel?: string
}
```

Behavior:
- 22px height, 12px, items `padding: 0 5px`, hover background, no focus outline unless the item is interactive.
- Left: workspace name, branch-like cwd, agent summary (`3 working`, `1 needs you`), save state.
- Right: zoom percent, lock state, clean view, theme, connection, version.
- `role="status"` with `aria-live="polite"` for agent summary changes. Do not announce every timer tick.
- Remote-style item uses `--vscode-statusBarItem-remoteBackground` and white foreground.

#### ActivityBar

```ts
interface ActivityBarProps {
  items: { id: string; label: string; icon: ReactNode; badge?: number; active?: boolean; onClick: () => void }[]
  bottomItems?: ...
}
```

Behavior:
- 48px wide, full height, 48x48 items, icon 24px, `aria-label`, `title`, `aria-current="page"`, active left border 2px accent.
- Badge bottom-right, 16px, 9px text, `--vscode-activityBarBadge-background`.
- Keyboard Tab moves through items. Arrow keys are optional but recommended. Each item is a button.
- Tooltip on hover and focus, 500ms.

#### MenuBar

- 35px row inside the title bar, 13px labels, items `padding: 0 8px`, hover background.
- Menus: File, Edit, View, Terminal, Help. Only include commands that exist.
- Hover opens a menu only after one menu is already open, matching VS Code. A single click opens.
- Escape closes, ArrowLeft/Right switch top-level menus, ArrowDown opens.
- On narrow widths, collapse to a single hamburger menu. Do not hide commands without an alternative.

#### SplitView

- Prefer `VscodeSplitLayout` for the bottom panel. `split="horizontal"`, `handle-size="4"`, `min-start="77px"`, `min-end="0"`, `initial-handle-position` persisted.
- Verify: React Flow still resizes, sash drag does not select text, double-click resets to 40 percent, keyboard resize works (the element may not support it, wrap with a focusable sash if not).
- Do not use `VscodeSplitLayout` for the sidebar-to-editor split in phase 1. A CSS grid with a custom 4px sash is more predictable and avoids a shadow-DOM child measuring the canvas. Revisit after lane 7.

#### Notification / Toast

```ts
interface NotificationProps {
  id: string
  severity: 'info' | 'warning' | 'error'
  title: string
  message?: string
  actions?: { label: string; onClick: () => void }[]
  sticky?: boolean
  onClose: () => void
}
```

Behavior:
- Bottom-right, 3px above the status bar, max-width 400px, stack newest on top, maximum 3 visible, overflow opens the notification center.
- Header 35px with severity icon, title 13px, close icon. Actions are 24px buttons.
- `role="status"` for info, `role="alert"` for warning and error. Never auto-dismiss an error or an approval-related message. Auto-dismiss info after 8s, pause on hover or focus.
- Notification center uses a 35px header and a list of 22px rows. Open from the status bar bell if a center exists.

#### EditorTabBar

- 35px height, background `--vscode-editorGroupHeader-tabsBackground`, bottom border.
- Active tab: top border 1px accent, background `--vscode-tab-activeBackground`, foreground active.
- Inactive tab: background `--vscode-tab-inactiveBackground`, foreground muted.
- Tab content: icon 16px, label 13px, dirty dot (7px) or close button. Close appears on hover and on active tab.
- Overflow: horizontal scroll with fade masks. Wheel deltaY translates to horizontal scroll. Active tab is revealed on change.
- Keyboard: Left/Right move, Enter activates, Delete or Cmd/Ctrl+W closes only when focus is in the tab strip and the browser does not own the chord.
- Workspace tabs use this component. Node tabs use the same component only if product approves the node-tab behavior.

#### Breadcrumbs

- 22px height, 12px, path segments separated by a chevron, muted separators, last segment foreground.
- Clicking a segment focuses the directory or file. Overflow collapses from the left into a leading ellipsis menu.

#### FindWidget

- 24px input, 22px buttons, positioned top-right inside the node, 4px radius, shadow, z-index 30.
- Enter next, Shift+Enter previous, Escape close, match count text 11px.

#### FileTree

- Use `VscodeTree` only if it survives React Flow: wrap in `nodrag nowheel`, stop pointer propagation, and test drag, scroll, and keyboard inside a transformed node.
- Rows 22px, indent 8px, indent guides, folder chevrons, file icons, 13px labels, active selection and hover tokens.
- Breadcrumb 22px above the list. Inline actions on row hover (new file, new folder, refresh).
- If `VscodeTree` fails inside the canvas, build a native `FileTree` with the same row metrics. Do not ship a tree that breaks node dragging.

---

## 4. Eight-lane parallel plan

### 4.1 Ownership map

No lane may edit a file owned by another lane. Shared contracts live in `src/client/shell/contracts.ts` and `src/client/components/vscode/contracts.ts`, owned by lane 1, and are frozen before lane 2 starts.

| Lane | Name | Owned files | Depends on |
|---|---|---|---|
| L1 | Foundation, theme, primitives | `package.json`, `bun.lock`, `src/client/components/vscode/**`, `src/client/vscodeTheme.css`, `src/client/index.css`, `src/client/styles.css` token block only, `src/client/main.tsx`, `src/client/shell/contracts.ts`, `src/client/lib/vscodeEvents.ts`, `src/client/test/vscodeTestUtils.tsx`, `src/client/dev/VscodeKitchen.tsx`, `src/client/vscodeSmoke.test.tsx` | none |
| L2 | Shell, title bar, activity bar, status bar | `src/client/App.tsx`, `WorkspaceBar.tsx`, `Dock.tsx`, `dock.css`, new `src/client/shell/TitleBar.tsx`, `MenuBar.tsx`, `ActivityBar.tsx`, `EditorTabBar.tsx`, `StatusBar.tsx`, `EditorToolbar.tsx`, `shell.css`, `shellKeyboard.ts`, `dockSessions.test.tsx`, `dockMerge.test.tsx`, new shell tests | L1 |
| L3 | Sidebar Sessions tree | `SessionsPanel.tsx`, `SessionRow.tsx`, `sessions-panel.css`, `sessionsPanelOpen.test.tsx`, new `sessionTree.ts`, `sessionTree.test.ts` | L1, L2 slot contract |
| L4 | Bottom panel Inbox and Chat | `InboxPanel.tsx`, `inboxPanelChrome.tsx`, `inboxPanelSections.tsx`, `inboxItemRow.tsx`, `inboxApprovalDialog.tsx`, `inboxPanelDialog.tsx`, `inbox.css`, `ChatPanel.tsx`, `chat/*.tsx`, `chat/chat.css`, `Kanban.tsx`, new `bottomPanel/BottomPanel.tsx`, `bottomPanel.css`, matching tests | L1, L2 slot contract |
| L5 | Settings, dialogs, onboarding | `SettingsPanel.tsx`, `SettingsFields.tsx`, `SettingsAgents.tsx`, `settings.css`, `FolderPicker.tsx`, `HelpOverlay.tsx`, `Welcome.tsx`, `Login.tsx`, `Login.test.tsx`, `welcome.test.tsx`, new settings tests | L1 |
| L6 | Command palette, menus, overlays | `CanvasToolbar.tsx`, `canvas-ui.css`, new `command/CommandPalette.tsx`, `command/commandActions.ts`, `command/commandRank.ts`, `NodeContextMenu.tsx`, `CanvasContextMenu.tsx`, `CanvasMenuRow.tsx`, `canvasMenu.pane.tsx`, `agent.css`, `canvasContextMenu.test.tsx`, `terminalNodeMenu.test.tsx`, new command tests | L1 |
| L7 | Node chrome, editor, files | `NodeChrome.tsx`, `NodeToolbar.tsx`, `NodeColorSwatch.tsx`, `NodeComments.tsx`, `TerminalNode.tsx`, `AgentNode.tsx`, `EditorNode.tsx`, `FilesNode.tsx`, `FindBar.tsx`, `UsagePill.tsx`, `node-chrome.css`, `editor.css`, `files.css`, new node tests | L1, L6 menu contract |
| L8 | Tests, visual QA, cleanup | `src/client/**/*.test.tsx` only after L2-L7 merge, `scripts/visual/**`, `RND/qc/20-vscode-ui/**`, this document's status log, `CHANGELOG.md` at release time | L1-L7 |

Lane 8 does not edit production source. Every visual or behavior defect found by L8 goes back to the owning lane as a fix, then L8 re-runs the checklist. This keeps ownership honest.

### 4.2 Lane briefs

#### L1, foundation

Deliver:
1. Add `@vscode-elements/react-elements@2.4.0`. Let its dependency resolve `@vscode-elements/elements@2.5.1`. Add `@vscode/codicons` only if the kitchen sink proves codicon icons are needed.
2. Create per-component wrappers with deep imports, not the barrel:

```ts
import React from 'react'
import { createComponent } from '@lit/react'
import { VscodeTabs as WC } from '@vscode-elements/elements/dist/vscode-tabs/vscode-tabs.js'

export const VscodeTabs = createComponent({
  tagName: 'vscode-tabs',
  elementClass: WC,
  react: React,
  displayName: 'VscodeTabs',
  events: { onVscTabsSelect: 'vsc-tabs-select' },
})
```

Deep imports keep the bundle to the components actually used. The barrel imports all 39 components and defeats tree shaking.

3. Create `contracts.ts` with the shell and component interfaces from section 3, plus event detail types:
   - `vsc-tabs-select`: `{ selectedIndex: number }`
   - `vsc-tree-select`: `{ selectedItems: VscodeTreeItem[] }`
   - `vsc-split-layout-change`: `{ position: number; positionInPercentage: number }`
   - `vsc-context-menu-select`: `{ label, keybinding, value, separator, tabindex }`
4. Add `vscodeTheme.css` with phase A bridge and phase B exact tokens behind `data-ui="vscode"`.
5. Build shell primitives: `Dialog`, `Panel`, `Popover`, `Menu`, `MenuBar`, `Tooltip`, `Card`, `Switch`, `QuickPick`, `StatusBar`, `ActivityBar`, `EditorTabBar`, `Breadcrumbs`, `FindWidget`, `Notification`.
6. Add a dev kitchen sink at `?kitchen=1` that renders every primitive in both themes and at both widths. This is the visual gate before lanes 2 to 7.
7. Add test utilities for custom elements: `renderVscode`, `getVscodeEvent`, `fireVscodeEvent`, `hostQuery`.
8. Add a bundle budget script that fails if the shell chunk exceeds +90KB gzip over the current build.

Exit gate G1:
- `TMPDIR=/tmp/st npm run typecheck` passes.
- `TMPDIR=/tmp/st npm test` passes, including the new smoke test.
- Kitchen sink screenshot at 1440x900 and 1778x1000, dark and light.
- Bundle delta recorded.
- jsdom proof documented: which elements render, which events fire, which controls need native fallback.

#### L2, shell

Deliver:
1. Replace the flex shell with the CSS grid from section 1.2. Keep `.app-main` as the canvas carrier if it helps, but the grid cell must be the height source.
2. `TitleBar`: 35px, menu bar left, brand and workspace identity, command center center, logout and window actions right.
3. `EditorTabBar`: workspace tabs, 35px, active top border, status dot, kebab, rename inline, overflow fade, wheel scroll, reveal active tab.
4. `ActivityBar`: 48px, Sessions, Inbox with badge, Chat, Board, Settings, Help. Bottom group for logout. Move dock actions:
   - Add node -> editor toolbar `+` and command palette.
   - Undo, redo, back, forward, fit, board, zoom, lock, clean view -> editor toolbar and status bar.
   - Every existing `aria-label`, `title`, `aria-pressed` must have an equivalent.
5. `StatusBar`: 22px with workspace, agent summary, save state, zoom, lock, clean view, theme, connection.
6. `EditorToolbar`: 22px `VscodeToolbarContainer` at the top-right of the canvas, not floating over the tab strip.
7. Add, Zoom, Workspace dialogs: 480px VS Code modal, 24px inputs, 22px option rows. Keep Escape and Enter behavior.
8. Clean view: hide title bar, activity bar, sidebar, panel, status bar, editor tabs, toolbar. Keep canvas and node headers. Keep the exit hint.
9. Wire the `BottomPanel` import and `CommandProvider` from L1 contracts. If L4 or L6 are not merged, render placeholders with the correct dimensions. Do not edit L4 or L6 files.
10. Add `shellKeyboard.ts` for Cmd/Ctrl+B, Cmd/Ctrl+J, Cmd/Ctrl+, and Escape layering.

Exit gate G2:
- All dock actions reachable and keyboard reachable.
- Workspace create, rename, delete, switch, overflow, status dot, and inline edit pass.
- Canvas fills the editor cell at 1440 and 1778, no 0-height collapse.
- Clean view enters and exits.
- Existing tests pass or are updated with equivalent assertions.

#### L3, sidebar

Deliver:
1. 300px sidebar with 35px view title, actions, and a 22px section header row.
2. `VscodeTree` for project, status, and nodes groupings. Tree items carry stable `path` arrays, `open`, `selected`, and slotted icons.
3. Keep grouping semantics from `sessionList.ts` and `nodeList.ts`. Do not rewrite the data logic in the component.
4. Filter: search action toggles a 24px text field under the title. Escape clears. Keep `sidebarFilterKeyAction` behavior and stop propagation to React Flow.
5. Collapse state persists under `webterm.sessionsCollapsed`. Grouping mode persists under a new key only if product approves.
6. Recently closed as a collapsible tree section, same rows.
7. 22px rows, 8px indent, 13px labels, unread and status glyphs in `slot="icon-leaf"`, close action in `slot="actions"`.
8. Performance: 200 synthetic sessions, stable item identities, no full-tree remount on every status tick.

Exit gate G3:
- Project, status, nodes grouping all render and switch.
- Filter, clear, no-match state.
- Collapse persistence across reload.
- Keyboard focus and selection.
- Middle click closes a session.
- 300px width and 22px row height measured.

#### L4, bottom panel

Deliver:
1. `BottomPanel` with 35px title, `VscodeTabs` panel variant, Inbox and Chat tabs, refresh and close actions, 4px sash, height persistence.
2. Move Inbox and Chat off the floating top-right corner into the panel. Remove `offsetForInbox` and the shift logic.
3. Preserve all Inbox data behavior: poll, refresh, filters, selection, sections, approval flow, literal `APPROVE`, expiry, pending lock, no accidental approval.
4. Preserve all Chat behavior: conversation list, selected conversation persistence, SSE stream, rAF batching, optimistic send, 409 busy, stop, reconnect.
5. Kanban becomes an editor-area overlay or a third panel tab. Escape closes.
6. Use `VscodeCheckbox`, `VscodeCollapsible`, `VscodeBadge`, and VS Code list rows. Keep native inputs where label association matters.
7. Panel height and active tab persist. If both Inbox and Chat were open before the migration, choose one active tab and preserve unread counts. Document the behavior change.

Exit gate G4:
- `InboxPanel.test.tsx` and `ChatPanel.test.tsx` pass with updated selectors.
- Approval dialog opens above the panel, traps focus, restores focus, and cannot be approved without checkbox and phrase.
- Panel resize does not break canvas or terminal focus.
- Unread badge in the activity bar matches the inbox count.

#### L5, settings and onboarding

Deliver:
1. Settings as a VS Code settings view: 35px title row, 200px left nav, 13px labels, 22px category rows, content max-width 760 to 1000px.
2. Replace `Switch` with `VscodeCheckbox` for settings booleans. VS Code settings use checkboxes, not switches.
3. Replace `Input` and `Select` with `VscodeTextfield` and `VscodeSingleSelect` only after L1 proves label association or adds an accessible host label. Otherwise keep native controls with exact VS Code styling.
4. Field rows: label and description left, control right, 1px separator, 14px vertical padding. Keep number clamp on blur and hex color pair.
5. Agent settings: custom agent cards, 22px rows, destructive action with confirmation.
6. FolderPicker: 480px modal, breadcrumb, 22px tree rows, Select action.
7. Help: 480px modal or editor view with a 22px shortcut table. Verify every listed shortcut is actually installed.
8. Welcome and Login: 35px page title, 13px body, 24px inputs, 24px primary button. Keep token validation and reload behavior.

Exit gate G5:
- Settings persistence and all field types.
- Number clamp, select values, color hex, custom agent add/remove.
- Folder picker up and select.
- Help Escape and focus restore.
- Login success and failure.
- `Login.test.tsx` and `welcome.test.tsx` pass.

#### L6, command palette and menus

Deliver:
1. Global `CommandPalette` with commands: new terminal, new agent, new files, new workspace, add node, undo, redo, fit view, zoom in/out/reset, toggle sidebar, toggle panel, toggle board, toggle lock, clean view, settings, help, switch workspace, focus node.
2. Reuse `targetScore`, `rankTargets`, and `nodeTargets`. Keep `PALETTE_LIMIT` or raise it with a measured reason.
3. Rebuild `NodeContextMenu`, `CanvasContextMenu`, `CanvasMenuRow`, and `canvasMenu.pane` on the shared `Menu` primitive. Preserve submenu side and lift geometry from `canvasMenu.geometry.ts`. Do not put menu geometry logic inside the primitive.
4. Preserve the portal to `document.body` and viewport coordinates. React Flow transform must not affect the menu.
5. Tooltip and popover adoption for toolbar and status bar.
6. Notification center for save failures, reconnect, and terminal errors.
7. `CanvasToolbar` becomes a `VscodeToolbarContainer` plus palette entry, not a floating cluster.

Exit gate G6:
- `canvasContextMenu.test.tsx` and `terminalNodeMenu.test.tsx` pass.
- Menu keyboard, type-ahead, submenu flip, disabled rows, danger rows.
- Palette opens from both chords, ranks correctly, selects, closes, restores focus.
- Menus render above canvas, sidebar, and panel but below dialogs.
- Notifications do not steal focus.

#### L7, node chrome, editor, files

Deliver:
1. Node header: 28px, 13px title, codicon or lucide 16px actions, drag handle. Keep `nodrag` on every control.
2. `VscodeToolbarContainer` for node actions. Preserve active states, comment count, mic visibility rules, broadcast, hide links, maximize, close.
3. Color swatch popover with the eight existing colors and exact VS Code popover metrics.
4. Comments: VS Code comment thread, 13px, textarea, send on Enter, Shift+Enter newline.
5. Editor: Monaco `vs-dark` in dark and `vs` in light. 35px node tab row with dirty dot. 22px breadcrumb. Save, preview, image and PDF preview unchanged.
6. Files: VS Code Explorer rows, 22px, indent guides, breadcrumbs, inline actions. If `VscodeTree` breaks dragging, build native rows. Keep `listKeyAction`, type-ahead, and scroll reveal.
7. Find bar: 24px input, 22px buttons, match count.
8. Usage pill: `VscodeBadge` with 4px progress.
9. Do not touch xterm options, terminal themes, pane ratios, or React Flow geometry.

Exit gate G7:
- `terminalCore.test.tsx`, `paneSplit.test.tsx`, `fileOpenEdge.test.tsx`, `editor` tests pass.
- Node drag, resize, collapse, maximize, rename, color, comments.
- Terminal input, scrollback, search, pane split, middle click.
- Monaco save and Markdown preview.
- Files open, navigate, create, context menu.

#### L8, tests and visual polish

Deliver:
1. Full `typecheck` and `test` after all lanes merge.
2. Update remaining selectors. Add tests for shell geometry, activity bar, status bar, editor tabs, quick pick, menu, dialog, panel resize, notification.
3. Visual acceptance at 1440 and 1778, dark and light, using ego-browser. Archive screenshots under `RND/qc/20-vscode-ui/`.
4. Bundle budget check and report.
5. Accessibility pass: focus order, labels, `aria-current`, `aria-expanded`, `aria-activedescendant`, dialog naming, no keyboard traps.
6. Cleanup: remove `data-ui="vscode"` flag, delete dead shadcn files only after no imports remain, delete old dock CSS, remove `--float-gap` offsets that no longer apply, update CHANGELOG at release.
7. Update this document with the measured result and residual gaps.

Exit gate G8:
- All 19 existing test files pass with real assertions.
- New shell tests pass.
- Visual checklist passes at both widths and both themes.
- Bundle delta within budget.
- No known blocker.

### 4.3 Sequencing

```text
Phase 0  Spike (part of L1, first 2 days)
         package install, React 19 + Vite 8 proof, jsdom proof, bundle measurement
            |
Phase 1  L1 Foundation
         tokens, theme, primitives, kitchen sink, contracts
            |
Phase 2  L2 Shell skeleton (1 to 2 days)
         grid, title bar, activity bar, status bar, slots
            |
Phase 3  L3 | L4 | L5 | L6 | L7  (parallel)
         sidebar | panel | settings | menus | node chrome
            |
Phase 4  L2 integration finish
         wire BottomPanel, CommandProvider, remove placeholders
            |
Phase 5  L8 tests and visual QA
            |
Phase 6  Cleanup and release
```

Why L2 starts before the parallel wave: the shell grid is the integration contract. L3 to L7 can build against the frozen slots and CSS variables, but merging them before the grid exists creates a week of rebase conflicts in `App.tsx`. Keep L2 short and merge the skeleton early. L6 should land the `Menu` primitive before L2 and L7 consume it. L1 owns that primitive, so L2 and L7 are never blocked.

Concurrency: run L3 to L7 in one wave, five workers, explicit file ownership. If review bandwidth is the bottleneck, cap at three: L3, L4, L7 first, then L5 and L6. Do not run two lanes that touch the same file.

### 4.4 Merge and rollback

- Each lane works on `feature/vscode-ui-<lane>` from `feature/vscode-ui` and merges back only after its exit gate.
- Lane 1 merges first. No lane rebases across another lane's unmerged changes.
- `data-ui="vscode"` on `<html>` is the migration switch. It scopes the exact token block and any dual CSS. Remove it in L8.
- Rollback for the shell layout: revert the L2 merge. Rollback for the palette: remove `data-ui="vscode"`, which returns phase A tokens. Rollback for a primitive: revert L1 and switch imports back to shadcn. Keep each lane small enough for a clean revert.
- Do not squash L1 with L2. The foundation must be independently revertible.

---

## 5. Visual acceptance checklist via ego-browser

Run `bun run dev` and open `http://127.0.0.1:8700` with the ego-browser skill. Use a seeded fixture:
- 4 workspaces, 12 sessions, 6 nodes (2 terminal, 2 agent, 1 editor, 1 files).
- Agent statuses: 1 working, 1 blocked, 1 waiting, 3 done.
- 12 inbox items across `needs_you`, `review`, `broken`.
- 2 chat conversations, one with an active turn.
- Long workspace name, long node title, deep file path.

Capture at:
- 1440x900, dark and light.
- 1778x1000, dark and light.
- Optionally 1024x768 to check collapse behavior, not a parity target.

Evidence paths: `RND/qc/20-vscode-ui/<width>/<theme>/<id>-<surface>.png`.

### 5.1 Geometry

| ID | Check | Expected |
|---|---|---|
| V1 | Title bar height | 35px |
| V2 | Activity bar width | 48px, item 48x48 |
| V3 | Sidebar width | 300px default, resizable to 170px minimum |
| V4 | Editor tab strip | 35px |
| V5 | Status bar | 22px |
| V6 | Panel title row | 35px |
| V7 | Panel minimum | 77px, default 40 percent of editor area |
| V8 | Canvas fills remaining editor cell | No 0px, no scrollbar on the shell |
| V9 | Tree row | 22px |
| V10 | Menu row | 22px, min-width 160px |
| V11 | Quick pick | 600px wide, list max 440px |
| V12 | Input and button | 24px height |
| V13 | Scrollbar | 14px wide, 10px thumb |
| V14 | 1778 wide | Sidebar, canvas, and panel all expand, no clipped tab |
| V15 | 1440 wide | 12 workspace tabs overflow with fade, active tab visible |

### 5.2 Color and state

| ID | Check | Expected |
|---|---|---|
| V16 | Active workspace tab | top border 1px `#0078D4` dark, `#005FB8` light |
| V17 | Inactive tab | background `#181818` / `#F8F8F8`, foreground `#9D9D9D` / `#616161` |
| V18 | Active activity item | left border 2px accent, `aria-current=page` |
| V19 | Activity badge | 16px, accent background, white 9px text |
| V20 | Selected tree row | `#094771` dark, `#E8E8E8` light |
| V21 | Hover tree row | `#2A2D2E` dark, `#F2F2F2` light |
| V22 | Panel active tab | top border 1px accent |
| V23 | Status bar hover | token hover background, no layout shift |
| V24 | Menu | background `#1F1F1F` / `#FFFFFF`, border, shadow |
| V25 | Quick pick | `#222222` / `#F8F8F8`, focused row accent |
| V26 | Input | `#313131` / `#FFFFFF`, border, placeholder |
| V27 | Button primary | `#0078D4`, hover `#026EC1` |
| V28 | Button secondary | transparent or `#E5E5E5`, no accent fill |
| V29 | Dialog backdrop | canvas dimmed, dialog no shadow clipping |
| V30 | Light theme parity | every token swapped, no dark leftover, no warm beige |

### 5.3 Typography

| ID | Check | Expected |
|---|---|---|
| V31 | Shell text | 13px, font stack resolves to SF Pro on macOS |
| V32 | Status bar | 12px |
| V33 | Section header | 11px uppercase, letter-spacing 0.04em |
| V34 | Long names | ellipsis, no wrap, no layout push |
| V35 | Code and paths | monospace, no proportional fallback |

### 5.4 Interaction and keyboard

| ID | Check | Expected |
|---|---|---|
| V36 | Hover active tab | active tab does not lose its active treatment on hover |
| V37 | Keyboard focus | 1px accent ring, visible only with keyboard |
| V38 | Cmd/Ctrl+K | palette opens, input focused |
| V39 | Cmd/Ctrl+Shift+P | palette opens |
| V40 | Arrow, Enter, Escape in palette | active row moves, selection runs, palette closes and restores focus |
| V41 | Menu keyboard | Arrow, Home, End, Left, Right, Escape, type-ahead |
| V42 | Dialog focus | trap, Escape, restore focus to trigger |
| V43 | Cmd/Ctrl+B | sidebar toggles, canvas resizes without layout jump |
| V44 | Cmd/Ctrl+J | panel toggles, canvas resizes without layout jump |
| V45 | Panel sash | drag, double-click reset, keyboard resize |
| V46 | Clean view | chrome hides, canvas and node headers remain, chord exits |
| V47 | Tooltip | 500ms delay, Escape dismiss, no flicker when entering tooltip |
| V48 | Approval dialog | cannot approve without checkbox and exact `APPROVE`, no accidental click path |

### 5.5 Regression

| ID | Check | Expected |
|---|---|---|
| V49 | Terminal typing | input reaches the shell, no focus stolen by shell |
| V50 | Terminal scrollback | wheel scrolls terminal, not canvas |
| V51 | Canvas pan and zoom | unchanged, no shell overlay blocking |
| V52 | Node drag and resize | unchanged, no jQuery-style jump |
| V53 | Pane split | split, resize, close pane works |
| V54 | Node context menu | opens at pointer, not offset by canvas transform |
| V55 | Monaco save | Cmd/Ctrl+S writes the file, dirty dot clears |
| V56 | Files open | file opens in editor node, context edge retained |
| V57 | Workspace switch | board swaps, tab active updates, viewport restores |
| V58 | Reload persistence | workspace, sidebar collapse, panel height, chat selection survive |

### 5.6 Accessibility and performance

| ID | Check | Expected |
|---|---|---|
| V59 | Landmark roles | title bar, activity bar, sidebar, editor, panel, status bar named |
| V60 | Accessible names | every icon-only button has a label, every tab has a name |
| V61 | Focus order | title, tabs, sidebar, canvas, panel, status, no trap outside dialogs |
| V62 | Color contrast | body text 4.5:1 or better in both themes |
| V63 | Palette performance | opens under 100ms with 50 items |
| V64 | Tree performance | 200 rows scroll smoothly, no full remount on status tick |
| V65 | Layout shift | zero measurable CLS on load and on panel toggle |

Pass rule: every item must pass at both widths in both themes. A failure is recorded with the viewport, theme, surface, expected, actual, and a screenshot. Lane 8 files the defect against the owning lane. Do not mark the migration complete with an open V item that affects a primary surface.

---

## 6. Risks

| # | Risk | Likelihood / impact | Why it happens | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Shadow DOM styling cannot reach internals | High / High | Only `vscode-button` exposes `part="base"`. Everything else is internal CSS | Theme exclusively through inherited `--vscode-*` properties. Do not write descendant selectors. Keep a kitchen sink for every state. Accept that a component that does not expose a needed state must be replaced with a native/custom one | L1 |
| R2 | Custom events do not fire or are mapped wrong | Medium / High | `@lit/react` maps `vsc-tabs-select`, `vsc-tree-select`, `vsc-split-layout-change`, `vsc-context-menu-select`. Event names are not `change` | Verify each event in the smoke test with a real dispatch. Keep `onVsc*` prop names, never `onChange` for these. Check `bubbles` and `composed` in the spike and document it | L1 |
| R3 | jsdom tests break on custom elements | High / High | Lit uses shadow DOM, constructable stylesheets, ResizeObserver, and internal focus. RTL cannot query shadow roots. `getByRole('button')` and `getByLabelText` fail | Keep native buttons and labeled inputs. Use `tagName` and attribute assertions for structural elements. Add polyfills in `test/setup`. Prove with a spike before committing to `VscodeTextfield` anywhere tests depend on labels | L1, L8 |
| R4 | Bundle size grows too much | Medium / Medium | The barrel imports all 39 components, 233KB min / 50KB gzip | Deep import per component. Never import the barrel in production. Budget +90KB gzip for the shell. Measure in CI with `vite build` and a chunk report | L1, L8 |
| R5 | Mixing shadcn and VS Code Elements produces two visual languages | High / High | Both ship focus rings, radii, shadows, and tokens | One primitive per role. Shadcn only for overlays until the custom VS Code version lands. No shadcn `Tabs` next to `VscodeTabs`. Run the audit in L8 and delete dead shadcn imports | L1, L8 |
| R6 | Canvas geometry collapses or jitters | High / High | React Flow needs a definite height. Grid, panel resize, sidebar toggle, and clean view all change the container | `min-height: 0` on every grid cell, `position: relative` on the canvas cell, explicit `height: 100%` on React Flow. Test panel drag and sidebar toggle with the 12-node fixture. If resize jitters, throttle panel height updates to animation frames | L2, L4, L8 |
| R7 | Portaled menus and tooltips offset by canvas transform | High / High | React Flow wraps nodes in a transformed container, which becomes the containing block for `position: fixed` | Always portal to `document.body`, compute from `getBoundingClientRect`, and keep the existing geometry functions. Add a node at 0.5 zoom and one at 2x zoom to the checklist | L6 |
| R8 | Behavior changes are mistaken for visual changes | High / High | Node tabs, panel tabs, settings-as-view, and workspace tabs in the title bar alter navigation | Treat each as an explicit product decision. Implement behind a flag or separate lane. Do not silently change defaults. Keep localStorage keys | L2, L4, L5 |
| R9 | Light theme is not VS Code Light Modern | Medium / High | Current light palette is warm beige with a separate canvas | Phase B exact tokens. Remove warm `--bg`, `--panel`, `--overlay` from shell surfaces. Keep a warm option only if product asks. Check every token in both themes | L1 |
| R10 | Accessibility regresses | High / High | Custom menu, palette, dialog, and tab strip can lose names, focus order, or escape layering | Build from the contracts in section 3. Add tests for focus trap, focus restore, roving tabindex, `aria-current`, `aria-expanded`, `aria-activedescendant`. Run the V59 to V62 checklist | L1, L8 |
| R11 | Existing 19 test suites fail broadly | High / High | Tests query shadcn roles, labels, and class names | Keep native form controls. Update only structural selectors. Never delete an assertion to make a test green. Add equivalent assertions for the new component | All lanes, L8 |
| R12 | Tree performance with many sessions | Medium / Medium | `vscode-tree` renders all items; 200 sessions means a large DOM | Keep node identities stable. Memoize row view models. Measure 200 rows. If it fails, add windowing or a custom virtualized tree. Do not virtualize phase 1 | L3 |
| R13 | FilesNode tree fights React Flow | Medium / High | Pointer, wheel, drag, and focus events inside a transformed node | Wrap in `nodrag nowheel`, stop propagation at the boundary, test drag and scroll. Fall back to native rows if `VscodeTree` cannot be isolated | L7 |
| R14 | Codicon dependency is added late | Low / Medium | `vscode-icon` and `VscodeToolbarButton` need the codicon stylesheet | Decide in L1. If used, import `@vscode/codicons/dist/codicon.css` once with id `codicon-stylesheet`, verify glyphs in the kitchen sink, measure the font size. Otherwise use lucide and accept a small icon mismatch | L1 |

Additional generic risks:
- CSS cascade order: `vscodeTheme.css` must load after `styles.css` and before component CSS. A wrong order silently overrides tokens. Add a cascade test or a visual check.
- `--tabbar-h` is referenced by `canvas-ui.css`, `inbox.css`, `chat.css`, `sessions-panel.css`, and `Kanban.tsx`. Replacing it requires a grep and a full pass. Do not leave a 46px ghost.
- xterm focus: the shell must not add a window keydown handler that swallows terminal keys. Use the existing `terminalShortcutPolicy` gate.
- Clean view currently hides `.tabbar` and `.dock`. New shell classes must be added to `cleanView.css`, otherwise clean view shows a half shell.

---

## 7. Open decisions requiring confirmation

These are questions, not approved changes.

1. **Workspace tabs placement.** Keep them in a 35px editor tab strip under the title bar, or move workspace switching into a title bar dropdown and use the tab strip only for nodes?
2. **Node tabs.** Add a 35px node tab strip above the canvas, or keep nodes as canvas-only cards? Adding tabs changes navigation and needs new state, keyboard, and persistence.
3. **Inbox and Chat.** One bottom panel with two tabs, or keep two floating surfaces and only restyle them? Tabs mean only one surface visible at a time.
4. **Settings.** Full-area editor view like VS Code, or a 480px modal? The editor view is more VS Code-like but changes the current full-screen modal behavior.
5. **Palette.** Adopt VS Code Dark Modern and Light Modern exactly, or keep the warm light palette and only bridge `--vscode-*`? Exact parity requires dropping the warm palette.
6. **Native controls.** Accept native buttons and inputs styled to VS Code for accessibility and tests, or require `VscodeButton`, `VscodeTextfield`, `VscodeCheckbox` everywhere and rewrite the test suite around shadow DOM?
7. **Codicons.** Add `@vscode/codicons` for exact VS Code icons, or keep lucide and accept a small icon mismatch?
8. **Sidebar filter.** Keep the always-visible filter, or hide it behind a search action like VS Code Explorer? The latter is more VS Code-like but adds a click.

If any answer is "keep current behavior", that surface becomes a restyle lane, not a layout lane. This is the main scope lever.

---

## 8. Counts and evidence

### 8.1 Repository facts measured during this analysis

| Metric | Value |
|---|---|
| Client production TSX files | 44 top-level, plus 22 shadcn UI primitives |
| Client production TS files | 46 (excluding tests) |
| Client CSS sheets | 13 |
| Client CSS lines | 2,405 |
| Client test files | 19 |
| Total client source lines read in line counts | 15,502 including tests |
| Files inspected for this document | 52 source files, 13 read partially (large files read at the head or through CSS extraction) |
| Surfaces mapped | 24 named surfaces |
| Inventory rows | 50 |
| Missing components specified | 17 |
| Lanes | 8 |
| Visual acceptance checks | 65 |
| Risks | 14 numbered plus 4 cross-cutting notes |
| Verified npm versions | react-elements 2.4.0, elements 2.5.1 |
| Verified VS Code source constants | title bar 35, activity bar 48, sidebar 300/170, editor tabs 35, status bar 22, panel minimum 77 |

Working tree note: at verification time, `git status` also showed modified `package.json`, `bun.lock`, `src/client/main.tsx`, and an untracked `src/client/vscode/` directory containing `register.ts`, `vscode-theme.css`, and `foundation.test.tsx`. This analysis did not create or edit those files. They appeared during the analysis window and look like a concurrent foundation lane. If that is the intended foundation location, use `src/client/vscode/**` instead of the proposed `src/client/components/vscode/**` in lane 1, and keep one owner for the directory. Do not merge two foundation layouts.

### 8.2 What this document does not prove

- It does not prove the migration is pixel-identical. Pixel parity is established only by the ego-browser checklist at both widths and both themes.
- It does not prove `@vscode-elements` works under jsdom. That is spike task G0 in lane 1.
- It does not prove `VscodeTree` works inside a transformed React Flow node. That is lane 7 gate.
- It does not prove the final bundle size. That is measured after lane 1 and again in lane 8.
- It does not approve any behavior change in section 7.

### 8.3 Recommended first action

Run the lane 1 spike before writing production UI code:
1. Install the two packages in a scratch branch.
2. Render `VscodeTabs`, `VscodeTree`, `VscodeToolbarContainer`, `VscodeTextfield`, and `VscodeSplitLayout` in a kitchen sink at both themes.
3. Run one jsdom test that dispatches a real click and reads the custom event.
4. Measure the bundle with deep imports versus the barrel.
5. Report the result and the rollback cost.

If the spike passes, start lane 1 with the exact token blocks and contracts. If the spike fails on jsdom or canvas isolation, keep the native primitive strategy and still use VS Code Elements only for the surfaces that survive. That is a better outcome than discovering the failure after seven lanes have merged.

---

*End of plan. No source files were edited by this analysis. This document is the only artifact it created.*
