# Header to rail layout

Status: **superseded by "Rework 2026-11-19" (end of this file)** in everything about workspace tiles, the Full/Compact/Hidden modes and the menu bar. The sections above are kept as the history of the first attempt; where they disagree with the rework, the rework wins. Designed 2026-11-19 from a read-only audit of `main` at `35a0ff8`.

## Problem

The app header takes two rows (35px title bar + 35px workspace tab strip = `--tabbar-h` 70px) on every screen, and the left rail has no workspace identity. The owner wants the workspace tabs and the `File/View/Help` menu moved to the left rail, and the header either slim or hidden, so the canvas gets the space back.

## Decision

1. **Three header modes**, one per-device preference: `full` (today), `compact` (one 35px row), `hidden` (no row; the rail is the only permanent chrome). Default `compact`.
2. **Workspaces become colored tiles in the left rail** in `compact` and `hidden`. `full` keeps the tab strip and does not show tiles (one surface per control).
3. **The `File/View/Help` menus become one menu button at the top of the rail** (VS Code's "compact menu" pattern) in `compact` and `hidden`. `full` keeps the menu bar.
4. **Hidden reveals the header on a pointer push at the very top edge of the window**, with no invisible element (see Hidden reveal).
5. **Nothing is removed.** Every control keeps a home in every mode (inventory below). A control may be merged with an existing twin only where the twin does the same thing.
6. **No native-only layout.** Native (Electrobun) loads the same `dist/` bundle; the code never branches on native. The native window keeps its OS title bar now, so no drag region is needed (see Native).

## Audit: what exists today

Facts read from the code (paths under `src/client` unless noted).

- Grid (`styles.css`): rows `--title-bar-h` 35px, `--editor-tabs-h` 35px, `1fr`, `--status-bar-h` 22px; columns `--activity-bar-w` 48px, side bar `--ss-w`, canvas, `--aux-w`. `--tabbar-h = title + tabs` is the **only** source of "how far down chrome starts" for floating UI: `Kanban.tsx`, `secondarySideBar.css`, `MorningBrief.css`, `ConnectionStatus.tsx`. `--activity-bar-w` is read the same way by `inboxPanelSurface.css`, `secondarySideBar.css`, `Kanban.tsx`. Changing these two tokens (not the call sites) moves all of them.
- `WorkspaceBar.tsx` (305 lines, 300 limit) renders `<header class="app-titlebar">` (brand, `VscodeMenuBar`, command-center pill, `titleActions` + `AccountMenu`) and `<div class="app-tabs">` (`VscodeEditorTabBar` + `+` + layout toggle), plus hosts (color picker, workspace create, `+` menu, tab context menu). `App.chrome.tsx` wires it (`AppWorkspaceBar`). It renders **always**, also on Welcome (no workspaces) and during boot.
- The rail is `Dock.tsx` (`VscodeActivityBar`, 48px) and is rendered **only** when hydrated with at least one workspace (`App.tsx`: `hydrated && !noWorkspaces`). Consequence: with zero workspaces there is no rail, so the header is the only door to `+`, Settings, Help. Rule below: the effective mode is `full` then.
- Clean view (`Mod+.`, `cleanView.tsx/css`, not persisted by design) hides title bar, tabs, status bar, dock, side bars. Its CSS comment records a lesson we keep: invisible hover bands "eat clicks on the row the shell uses for its prompt", so clean view has no hover-reveal. Header modes must not repeat that (Hidden reveal uses no element).
- Workspace identity: 12 hues x 3 shades (`shared/workspaceColor.ts`, tokens `--ws-<hue>-<shade>` in `workspaceColor.css`, contrast-tested by `workspaceColor.contrast.test.ts` at 3:1 for non-text). Tab dot = `WorkspaceTabDot` (identity fill + status corner badge). **Status is only known for the active workspace** (`workspaceTabs.ts`: only the open workspace has a socket, so inactive dots are neutral and the tooltip says so). The rail must keep that truth: no fake status on inactive tiles.
- Workspace order: the tab order is the array order of `workspaces`. I found no user-controlled order and no `position` column; `server/db.ts` lists `ORDER BY updated_at DESC`. I did not trace how the client turns that into tab order, so **drag-to-reorder needs a first step: read that path, then add a persisted order (migration)**.
- Keyboard: there is **no existing shortcut to switch workspaces** (only Central's `workspace.switch` tool and arrows inside the tab strip). So "existing switching shortcuts keep working" means the strip's arrow/Home/End/Enter/Shift+F10 behavior; new shortcuts are an addition.
- Registry chords already used (grep of `commandRegistry.defaults.ts`, `tabLayout.keys.ts`, `outputChord.ts`): `Mod+K`, `Mod+P`, `Mod+Shift+F`, `Mod+,`, `Mod+.` (clean view), `Mod+Shift+\` (side bar), `Mod+Alt+B` (secondary side bar), `Mod+Shift+L` (tab layout), `Mod+Shift+U` (output), `Mod+Shift+[` / `]`, `Mod+G`, `Mod+Shift+G`, `Mod+Alt+R`, `Mod+Alt+J`, `Mod+W`, `Mod+\`. `Mod+Shift+H` and `Mod+Alt+H` are free inside the app (no `view.header` command exists).
- Native: `src/native/nativeApp.ts` creates `new BrowserWindow({ title, frame: {x,y,width,height}, ... })` with no `titleBarStyle`, so the OS title bar is present and draggable. No `-webkit-app-region` exists anywhere in `src`. The native app menu has `hide` and `hideOthers` roles (so `Cmd+Alt+H` is taken natively).
- Small screens: the shell has no `@media` queries. The only narrow rule is `useNarrowWindow` (`< 900px`) turning the secondary side bar into an overlay.

## Inventory: every header control

`Full` = today. Destinations: **T** tab strip, **M** rail menu button, **R** rail, **P** palette (`Mod+K` commands), **H** header row kept. "Gone in X" never means unreachable; the right column of each row says where it lives.

| # | Control | Owner file | Behavior | Shortcut | State read | Full | Compact | Hidden |
|---|---|---|---|---|---|---|---|---|
| 1 | Brand mark + "webterm" | `WorkspaceBar.tsx` | Static label, no action | none | none | H | dropped (no function; the rail menu button is the app's anchor) | dropped |
| 2 | Menu bar, lone-Alt focus | `vscodeMenuBar.tsx` | Alt press focuses the menu bar; arrows move between menus | Alt | none | H | rail menu opens on Alt; same menu model | same as Compact |
| 3 | File: New Workspace | `WorkspaceBar.tsx` | `onNewWorkspace()` opens folder picker | none | none | H | M, R (`+`) | M, R |
| 4 | File: Clone Repository… | same | `openWorkspaceCreate('clone')` | none | none | H | M, R (`+` menu) | M, R |
| 5 | File: New Project… | same | `openWorkspaceCreate('project')` | none | none | H | M, R (`+` menu) | M, R |
| 6 | File: New Files Node | same | `onNewFiles` on the active board | none | active workspace | H | M (also P `files.new`) | M, P |
| 7 | File: Rename Workspace… | same | inline editor on active workspace | none (tab dblclick) | active workspace | H | M, R tile menu | M, R tile menu |
| 8 | File: Delete Workspace | same | `window.confirm`, then worktree offer, then delete | none | active workspace, session count | H | M, R tile menu | M, R tile menu |
| 9 | File: Settings… | same | opens Settings | `Mod+,` | none | H | M, R bottom gear (exists) | M, R |
| 10 | File: Account… / Sign out | same | `onOpenAccount`, `onLogout` | none | `showLogout` | H | M, R account button | M, R |
| 11 | View: Toggle Tab Layout | same | `toggleLayoutMode`, disabled without active workspace | `Mod+Shift+L` | `layoutMode`, active workspace | H | M, P, row 22 | M, P |
| 12 | View: Output / Clear Output | same | `toggleOutput`, `clearOutput` | `Mod+Shift+U` | none | H | M, P (`outputCommands` already in the omnibox), status bar | M, P |
| 13 | View: **Header** (new) | `workspaceBar.menus.ts` | Full / Compact / Hidden radio | `Mod+Shift+H` toggles Hidden | header mode | H | M | M |
| 14 | Help: Keyboard Shortcuts Reference, Set up webterm… | same | `onOpenHelp`, `openSetup()` | none | none | H | M, P (`workbench.keybindings`, `workbench.setup`) | M, P |
| 15 | Command center pill | `WorkspaceBar.tsx` | Opens omnibox; shows active name, color chip, worktree badge, chord | `Mod+K` | active workspace, color, worktree status | H | H (the single row) | R search button, `Mod+K` |
| 16 | Worktree badge (in pill) | `WorkspaceWorktreeBadge` | Branch / dirty state | none | `useWorktreeStatuses` | H | H (in pill) and tile tooltip | tile tooltip, status bar workspace chip |
| 17 | Secondary side bar toggle | `App.secondarySideBar.tsx` | Toggles Central chat/control panel | `Mod+Alt+B` | side bar open | H | H actions cluster (keeps toggle semantics: last view) | R Central item (exists; opens Chat) + `Mod+Alt+B` |
| 18 | Account menu button | `AccountMenu.tsx` | Who is signed in, Account settings, Settings, Keyboard Shortcuts, Sign out | none | `showLogout`, `fetchMe` | H | R bottom (above Settings) | R bottom |
| 19 | Workspace tab (select) | `vscodeEditorTabBar.tsx` | Activate workspace; arrows/Home/End/Enter/Space | arrows in strip | `activeId` | T | R tile | R tile |
| 20 | Tab status dot + corner badge | `WorkspaceTabDot.tsx` | Identity fill + working/attention badge (active workspace only) | none | `buildSessionList`, `statuses` | T | R tile (same data, same truth rule) | R tile |
| 21 | Tab dirty marker (worktree) | `WorkspaceBar.tsx` | Dirty worktree dot | none | worktree `dirtyCount` | T | R tile corner | R tile corner |
| 22 | Layout toggle (canvas/tabs) | `WorkspaceBar.tsx` | Board layout switch, hidden with no workspace | `Mod+Shift+L` | `layoutMode`, active workspace | T row, far right | H actions cluster | R bottom group (toggle, `aria-pressed`) |
| 23 | `+` New workspace menu | `WorkspaceBar.tsx` | Menu: Open Folder…, Clone Repository…, New Project… | none | none | T | R, end of workspace group | R |
| 24 | Inline rename | `WorkspaceTabRename.tsx` | Double-click a tab, Enter/Escape/blur, busy + error | double-click | editing id | T | R tile: double-click / `F2` opens the same editor in a popover | same |
| 25 | Tab context menu | `WorkspaceTabMenu.tsx` | Rename, Canvas Background…, Color…, Mute/Unmute Notifications, Delete | right-click, `Shift+F10`, ContextMenu key | muted ids, active | T | R tile, same component, same rows | same |
| 26 | Tab strip overflow | `vscodeEditorTabBar.tsx`, `workspaceTabs.ts` | Fade, wheel, reveal-active, scroll | wheel | scroll geometry | T | replaced by vertical scroll + All workspaces (row 27) | same |
| 27 | Color picker host | `WorkspaceColorPicker.tsx` | 12 hues x 3 shades dialog | via row 25 | workspace color | host | host (shared) | host (shared) |
| 28 | Workspace create host | `workspaceCreate/WorkspaceCreateHost` | Clone / new project flow | via rows 4, 5, 23 | none | host | host (shared) | host (shared) |
| 29 | All workspaces (new) | `WorkspaceRail.all.tsx` | Quick pick list of every workspace with color chip and filter | none (`Mod+Alt+ArrowUp/Down` for prev/next, new) | `workspaces` | n/a (strip scrolls) | R | R |

29 rows; 26 leaf actions (File 9, View 3, Help 2, Account 4, tab menu 5, `+` menu 3) are all preserved. Rows 13 and 29 are new; row 1 is the only one dropped, and it has no behavior. Controls that only make sense in Full: row 1, row 26 (strip overflow), and the horizontal tab strip itself.

Twins to merge on purpose (same action, two doors today): Settings (rows 9, 18, rail gear), Keyboard Shortcuts (rows 14, 18). In Compact/Hidden each keeps the rail/menu door and the palette door; the Account menu keeps its own copy as it does today.

## Header modes

| | Full | Compact | Hidden |
|---|---|---|---|
| Rows | title 35 + tabs 35 | one row, 35 | none (0); overlay on reveal |
| `--tabbar-h` | 70px | 35px | 0px |
| Row content | brand, menu bar, pill, actions; tab strip, `+`, layout toggle | pill (workspace name + chord) centered, secondary side bar toggle, layout toggle | revealed overlay = the Full header |
| Workspaces | tab strip | rail tiles | rail tiles |
| Menu | menu bar | rail menu button | rail menu button |
| Search | pill | pill | rail search button + `Mod+K` |

`--tabbar-h` and the grid rows come from one class on `.app-shell` (`app-shell--header-compact|hidden`), set in one new stylesheet `headerMode.css`; `styles.css` (414 lines, 83% of the hard limit) only loses its two literal row tokens. All floating UI follows without edits because it reads `--tabbar-h`.

### Effective mode (derived, never persisted)

`effective = stored`, except:

- not hydrated, or zero workspaces: `full` (the rail does not exist; Welcome needs the header's `+`);
- `(hover: none)` (touch): `hidden` is treated as `compact` (no pointer, no reveal);
- clean view on: everything hidden as today; header mode untouched and restored on exit.

### Switching

- View > Header (radio, in the header menu and the rail menu), Settings > Appearance > Header (3-option segmented control, no typing), palette commands `View: Header: Full | Compact | Hidden | Toggle`, and the chord `Mod+Shift+H` = toggle between Hidden and the last non-hidden mode.
- Right-click on empty rail background opens the same three-row menu. (The brief's "right-click the thin area" is dropped: a thin invisible element is exactly what clean view's CSS warns against.)
- Chord check. In-app grep shows no clash. Terminal: the app-first policy bubbles registered chords, so xterm needs no change. External, from my own knowledge and **not verified in a browser this session**: Chrome and Safari on macOS use `Cmd+Shift+H` for Home, Firefox uses `Ctrl+Shift+H` for history. Chrome lets pages `preventDefault` non-reserved chords; Safari and Firefox behavior is unknown. The chord is a registry default, so a user can rebind it, and every function has a palette command. Alternative `Cmd+Alt+H` is rejected (native Hide Others).

### Hidden reveal

- **No element.** A window-level `pointermove` listener; reveal when `clientY <= 2`, `buttons === 0`, no node/pane drag in progress, pointer not captured, dwell 250ms. This cannot eat clicks (the lesson in `cleanView.css`).
- Reveal = the Full header slides over the canvas (`position: absolute`, z 30, no layout shift, 120ms ease, no motion under `prefers-reduced-motion`). It does not change `--tabbar-h`, so canvas pan/zoom and node positions never jump.
- Hide: 500ms after the pointer leaves the revealed header, and only if no menu is open and focus is not inside it.
- A 2px non-interactive hairline (`pointer-events: none`) along the top edge says "something is here".
- Keyboard: `Mod+Shift+H` leaves Hidden persistently (back to the last mode); `Mod+K` and the rail search never need the header.
- Pan edge case: the top 2px of the window is not a pan/drag target in practice, but a node dragged to the very top never reveals because `buttons !== 0`.

### Persistence and migration

- Store `webterm.headerMode` in `localStorage`, `useSyncExternalStore`, same pattern as `secondarySideBar.store.ts` (try/catch around storage). Per device on purpose: the same server serves a laptop, native and a phone, and the desired chrome differs. Not a server setting (`Settings` holds no client-only layout keys).
- **Default `compact` for everyone.** The key does not exist for any user, so nothing existing is overwritten (this is a new key, not a change to a stored one). Rationale (generous defaults: the space gain is the point; a `full` default would hide the feature behind a switch). Transparency (feedback-transparent-automation): on the first boot after the upgrade the app shows **one** notice, "Header is now compact", with a single **Restore full header** action; it appears once per device (flag in the same store) and never gates anything.

## Rail design

### Order (top to bottom), Compact and Hidden

1. **Menu button** (hamburger, 48x48). Opens the existing `VscodeMenu` model: File, View, Help as three submenus (VS Code compact menu). Lone-Alt and `F10` focus it.
2. **Search** (Hidden only): `Mod+K`.
3. **Workspace group** (divider above and below): active tile pinned first among visible rows, then tiles in order, then `+` (menu from row 23), then **All workspaces** when not every tile fits.
4. Existing tools group, unchanged and in the same order: Layers, Sessions, Agent History, Skills, Central, Board, Add node.
5. Bottom group: Account (new), Settings, Lock view (canvas mode only), Take screenshot (`canvas.screenshot`, see `screenshot-annotate.md`), Clean view (kept last: it is the way back out of a chrome-less screen), and, in Hidden only, the layout toggle (row 22; `aria-pressed`; in Compact it stays in the header row).

### Workspace tile

- **Shape and size**: 32px rounded square (radius 8px) centered in the 48px column, 8px side padding; item pitch 36px. Tokens (not literals): `--rail-ws-tile: 32px`, `--rail-ws-pitch: 36px` in `workspaceRail.css`.
- **Fill** = `workspaceColorVar(color, shade)` (the identity token). **Monogram** = first grapheme of the name, 14px bold (large text), `#fff` or `#000` chosen per token for the higher contrast. A new contrast test covers 36 fills x 2 themes at 3:1 (large text; falls to a fill-only tile with `aria-hidden` monogram if any token fails, and the test lists failing tokens). Name and color are in the accessible name, so the monogram is decoration.
- **Active**: 2px left bar in `--vscode-activityBarTop-activeBorder`/the rail's existing active indicator + 2px outer ring (`--vscode-focusBorder`, offset 2px). Inactive: no bar, no ring, same fill (no opacity change, so contrast is stable).
- **Status**: the existing corner badge (working / attention) from `WorkspaceTabDot`, **active workspace only** (same data-boundary rule as `workspaceTabs.ts`). Worktree dirty marker bottom-left. Inactive tiles say "status is live only for the open workspace" in the tooltip, as the tab tooltip does today.
- **Tooltip** (`IconTooltip`, side right): full name, session counts, worktree line, `Color: <name>` (the output of `workspaceTabFields`, reused unchanged).
- **Menu**: right-click, `Shift+F10`, ContextMenu key open `WorkspaceTabMenu` unchanged (Rename, Canvas Background…, Color…, Mute/Unmute, Delete). Rename opens `WorkspaceTabRename` in a popover anchored to the tile (double-click or `F2`).
- **Reorder**: pointer drag with a 4px threshold and an insertion line; keyboard alternative `Alt+Shift+ArrowUp/Down` (WCAG 2.5.7 dragging alternative). Order is persisted (see T2b); a failed save reverts the row and says why (action feedback policy).

### Many workspaces and short windows

Vertical budget (Compact, 800px viewport): 800 - 35 header - 22 status = 743px. Fixed rail content = menu 48 + tools 7x48 = 336 + bottom 5x48 = 240 + group chrome (`+`, All, dividers) about 80 = about 704px, leaving about 40px: **one tile**. A count rule such as "scroll above 8" would be wrong. So the rule is by fit:

- The workspace group is the only flexible region (`flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain`, thin scrollbar like the app's 8px one).
- The **active tile is `position: sticky` at the top** of the group, so the current workspace is always visible.
- When not all workspaces fit, **All workspaces** appears (quick pick via `VscodeQuickPick`: color chip, name, worktree line, type-to-filter, `New workspace…` as the last row). It is also the keyboard path to any workspace and exists with any count when tiles overflow.
- No tool overflow in v1. Accepted ceiling: below about 700px window height the group shows only the active tile plus All workspaces; all functions stay reachable.

### Expanded rail

Collapsed 48px by default. A **Show labels** toggle (rail menu, Settings > Appearance, palette) pins an expanded 220px rail with a name beside every item (tools and tiles). It changes `--activity-bar-w`, which already drives the side bar, secondary bar and Kanban offsets. Persisted per device with the header mode store. Hover-peek is not built (see Open questions 4): in a rail that is always visible, an expand-on-hover flickers when the pointer crosses the rail toward the canvas, and the canvas's left edge is a pan zone.

### Accessibility

- Workspace group: `role="tablist" aria-orientation="vertical" aria-label="Workspaces"` inside the rail `nav`; tiles are `role="tab"` with `aria-selected`, `aria-controls` = the canvas region id, accessible name = `workspaceTabAria` (name, color, agents waiting/running).
- Roving tabindex (one Tab stop for the group); ArrowUp/ArrowDown move, Home/End jump, Enter/Space activate, `F2` rename, ContextMenu/`Shift+F10` menu, `Alt+Shift+Arrow` reorder. The rest of the rail keeps `VscodeActivityBar`'s arrow model; the two groups are separate Tab stops so arrow keys never skip across a boundary.
- Focus ring 2px (`--bui-focus` convention), targets: tile 32px (above the 24px WCAG 2.2 minimum), menu/tool buttons 48px.
- New commands: `Workspace: Next`, `Workspace: Previous` (`Mod+Alt+ArrowDown/Up`), usable in every mode and in Full.

## Native and web

- One source: `src/client` renders both. The header mode code reads no native flag. A `native` branch in CSS or components is a policy failure (add a scan test, T3).
- Today the native window has the OS title bar (no `titleBarStyle`), so no `-webkit-app-region` is needed and the macOS drag zone is the OS bar in all three modes.
- If the owner later picks a frameless/inset window (`titleBarStyle: 'hiddenInset'`, Electrobun draws traffic lights over content): Compact row gets `-webkit-app-region: drag` with every button/pill `no-drag` and 78px left padding; Hidden gets a 28px drag strip that is also the reveal edge; the rail must start below the traffic lights. Electrobun documents draggable regions; an upstream issue (#561, status unknown) says double-click zoom on a drag region misbehaves with `hiddenInset`. Not done now.
- Small screens: no new breakpoint. Touch (`hover: none`) never gets Hidden. Below 900px the secondary side bar already overlays; rail stays 48px; Compact is the recommended and default mode there (same as everywhere).

## Implementation plan

### Wave 0: split `WorkspaceBar.tsx` (behavior-preserving, one worker)

`WorkspaceBar.tsx` is 305 lines; adding modes to it would breach the file-health limit. Split first:

| File (new unless noted) | Holds | Lines |
|---|---|---|
| `WorkspaceBar.tsx` (edit) | composition only | about 130 |
| `workspaceBar.menus.ts` | pure builders of File/View/Help `VscodeMenu[]` from props | about 90 |
| `useWorkspaceTabActions.ts` | menu/editing/color/add-menu state, `deleteWorkspace` confirm flow (`offerRemoveWorktree`) | about 80 |
| `WorkspaceBar.tabs.tsx` | `tabs` construction + `VscodeEditorTabBar` + `+` button | about 80 |
| `WorkspaceBar.hosts.tsx` | color host, create host, add menu, tab menu | about 60 |

Gate: existing `WorkspaceBar.*`, `workspaceBarChrome`, `styles` tests pass unchanged except import paths in `workspaceBarChrome.test.ts` (it greps `WorkspaceBar.tsx` source; it must read the split files).

### Wave T1: header modes (no workspace move)

Owner A (client chrome): `headerMode.store.ts`, `headerMode.commands.ts` (registry: `view.header.*`, chord `Mod+Shift+H`), `headerMode.css`, `useHeaderReveal.ts`, `HeaderModeNotice.tsx`, `AppMenuButton.tsx` (renders the menu model; in T1 it sits at the start of the tab row), edits to `styles.css` (remove two literal row tokens), `App.tsx` (class + hook), `App.chrome.tsx`, `workspaceBar.menus.ts` (View > Header radio), `commandRegistry.defaults.ts`.
Owner B (settings): `SettingsAppearanceSection.tsx` (segmented control + Show labels placeholder), settings search entries. No overlap with A.
Interim states, so nothing is unreachable: Compact (T1) = tab row only, with the menu button at its start and the pill replaced by a search icon at its end; Hidden (T1) reveals the Full header.

### Wave T2: workspace rail (parallel pair)

- T2a (client): `WorkspaceRail.tsx`, `WorkspaceRail.tile.tsx`, `WorkspaceRail.all.tsx`, `workspaceRail.keys.ts` (roving/reorder key logic, pure), `workspaceRail.css`, `workspaceTiles.ts` (monogram + contrast pick, pure), `workspaceNav.commands.ts` (`Workspace: Next/Previous`); edits to `Dock.tsx`, `Dock.types.ts` (new props), `App.chrome.tsx`, `App.workbench.tsx`; `workspaceColor.css` (tile tokens).
- T2b (server, independent): first read how the client orders `workspaces` (trace `api.ts`/lifecycle), then add `position` with a migration (idempotent `IF NOT EXISTS`, backfill from current order), `PUT /api/workspaces/order`, Central/`workspace.*` untouched; `server/db.ts` (owner), new `server/workspaceOrder.ts`, migration file, `workspacesApi*.bun.test.ts` additions. Client reorder wiring lands in T2a after T2b merges (T2a may stub the drag until then).

### Wave T3: menu and actions move to the rail, native checks

Owner: `Dock.tsx` (menu button group, Account button, layout toggle), `AccountMenu.tsx` (trigger variant for the rail: side right), `AppMenuButton.tsx` (relocated placement), `headerMode.css` (Compact row = pill + actions), `WorkspaceBar.tsx` (Compact/Hidden branches), expanded-rail "Show labels" (`vscode-shell.css`, `vscodeActivityBar.tsx`), native policy scan test. Docs worker last: README only if shortcuts tables change (limited update per Rule 16), CHANGELOG once.

### Tests per wave (kinds, not content)

| Wave | New / updated |
|---|---|
| W0 | existing `WorkspaceBar.menu/tabs/worktree`, `workspaceBarChrome`, `styles` re-pointed at split files |
| T1 | store (unit: default, persistence, bad value, notice once), `effectiveHeaderMode` (pure: zero workspaces, boot, touch, clean view), reveal hook (jsdom: edge, dwell, `buttons`, menu-open, focus-within), commands (registry: ids, chord, no duplicate chord with the terminal/editor/browser scopes), CSS scan (each mode sets `--tabbar-h` 70/35/0; no element with `pointer-events` inside the reveal edge), `styles.test.ts` rows, `App` harness mount in each mode |
| T2a | rail tiles (DOM: roles, aria, roving, arrow/Home/End, Enter, F2, ContextMenu, reorder keys), `workspaceTiles` (pure: monogram, contrast pick, 36 x 2 themes), overflow (active sticky, All workspaces appears, quick pick filters), tooltip equals `workspaceTabFields` output, `WorkspaceColor.ui.test.tsx` parity for the rail, `canvasHarness` rendering rail + header modes |
| T2b | bun: migration idempotent, backfill keeps order, order endpoint validation (unknown id, duplicates, 400), concurrent save does not reorder, a color/updated_at write does not change order |
| T3 | menu button opens the same menu model as the bar (model equality), Alt/F10 focus, Account in the rail, every inventory row reachable per mode (table-driven test that mounts each mode and finds the control by accessible name), expanded-rail width token, no-`native` branch scan |

Policy tests touched: `shadcnPolicy` (new buttons use `IconButton`/Radix; its allowlist mentions `titlebar__action`), `iconTooltipPolicy` (every new icon-only control through `IconTooltip`), `actionFeedbackPolicy` (reorder save and rename are async: `useAction`), `commandRegistry.labels.policy` (new command labels), `nodeHeaderIconPolicy` (node headers only; expected untouched), `browserUi.metrics` (browser files only; untouched), `workspaceColor.contrast`, and any new scanner registered in `scripts/test.policy.manifest.ts`. Canvas harness (`canvasHarness.tsx`) tests that mount `Dock` need the new props.

### Size, risks, gate

Rough size: W0 about 350 lines moved; T1 about 450 added; T2a about 700 added + tests about 600; T2b about 250 + tests; T3 about 350. Files stay under the 300/500 limits by construction (each row above is one concern).

| Risk | Mitigation |
|---|---|
| Floating panels use `--tabbar-h` / `--activity-bar-w` | All mode and width changes go through those two tokens; T1 test asserts the three values; no panel edited |
| Zero workspaces or boot has no rail | Effective mode derived to `full`; test table |
| Invisible edge eats clicks (clean-view lesson) | No element; `pointermove` only; `buttons === 0` guard |
| Vertical budget too small for tiles | By-fit overflow, sticky active tile, All workspaces; ceiling stated |
| Monogram contrast fails on some of 36 tokens | Per-token black/white, test lists failures; fallback fill-only |
| Reorder needs schema + order of unknown client path | T2b traces first, migration with guards; T2a stubs drag until merged |
| Rail shows status for workspaces it cannot know | Keep the active-only rule and tooltip wording |
| Shortcut external clash | Registry default, rebindable, palette commands; flagged open question |
| `styles.test.ts` and `workspaceBarChrome.test.ts` pin today's CSS/source | Update in the same wave, assert the new contract, do not loosen |

Gate per wave (narrow, no full suite): `TMPDIR=/tmp/st npm run typecheck` and `TMPDIR=/tmp/st npm run test:impacted` (touched `WorkspaceBar*`, `Dock*`, `styles`, `workspaceColor*`, the new tests, the policy tier). Server wave adds the bun tests it touches. Full suites only on the owner's command.

## Open questions (owner)

1. **Chord `Mod+Shift+H`.** Recommendation: keep it (free in-app, rebindable, palette commands exist). Clash risk is Home/History in Safari and Firefox, unverified. Say if you prefer another chord.
2. **Full mode: tiles too?** Recommendation: no. Full keeps the strip only; one surface per control.
3. **Drag-to-reorder needs a persisted order** (new DB column, shared by all windows). Recommendation: yes, T2b, because tiles with no way to arrange them are worse than tabs were.
4. **Expanded rail: pin only, no hover-peek.** Recommendation: pin only (flicker, left edge is a pan zone). Hover-peek can follow if you miss it.
5. **Native frameless window (`hiddenInset`).** Recommendation: not now; keep the OS title bar so the drag zone is free and the code stays one source. Revisit after T3 if the double title bar looks heavy.

Out of scope on purpose: status badges for **inactive** workspaces (the client has no data for them; a server-side per-workspace aggregate is a separate feature).

## Comparison with reference products

VS Code puts the menu behind a hamburger in the Activity Bar when `window.menuBarVisibility` is `compact`, and its compact menu returns to the Activity Bar when the custom title bar is hidden ([VS Code PR 345401](https://github.com/microsoft/vscode/pull/345401), [issue 144216](https://github.com/microsoft/vscode/issues/144216) shows the keyboard path matters when the bar is hidden), which is the model for our menu button and Alt/F10 behavior. Chrome added native vertical tabs in 2026, reached through "Show Tabs Vertically" on the tab strip or Settings > Appearance > Tab position; sources disagree on whether a flag is still needed in some builds, so I rely only on the existence of the feature ([Google announcement](https://blog.google/products-and-platforms/products/chrome/new-chrome-productivity-features/)). From general knowledge (not re-verified now): Arc keeps tabs in a collapsible sidebar and Linear puts the workspace switcher at the top of its sidebar; JetBrains' new UI offers a hamburger main menu when the menu bar is hidden. webterm differs in that the rail also hosts non-tab tools, so the workspace group must yield space by fit and keep the active tile sticky, which none of those pure tab sidebars need.

## Not verifiable without a screen

Tile legibility and the 14px monogram at the tokens' real colors, the feel of the 250ms/500ms reveal timings and the 2px edge trigger on a trackpad, whether the sticky active tile plus All workspaces looks acceptable at 800px height, the compact row's width budget when the pill, side bar toggle and layout toggle share 35px at narrow widths, and how Safari/Firefox treat `Mod+Shift+H`.

## Implementation status

Owner decisions (2026-11-19): all five recommendations approved (`Mod+Shift+H` kept, no tiles in Full, persisted workspace order in T2b, rail widened only by pinning, no frameless native window now).

- **W0 done** (branch `feature/header-modes`): `WorkspaceBar.tsx` split into `workspaceBar.menus.ts`, `useWorkspaceTabActions.ts`, `WorkspaceBar.tabs.tsx`, `WorkspaceBar.hosts.tsx`; no behavior change. `workspaceBarChrome.test.ts` now reads the split files.
- **T1 done** (same branch): `headerMode.store.ts` (`webterm.headerMode`, default `compact`, derived effective mode), `headerMode.commands.ts` (`View: Header: Full|Compact|Hidden`, `View: Toggle Header`, `Mod+Shift+H`), `useHeaderReveal.ts` (no element; 2px edge, 250ms dwell, `buttons === 0`, hide 500ms after leaving, held open by menus/focus), `headerMode.css`, `headerMode.notice.ts` (one-time "Header is now compact" with "Restore full header"), `AppMenuButton.tsx`, Settings > Appearance > Header (`SettingsHeaderMode.tsx`), View > Header radio in both menus.
  - Compact (T1 interim, superseded by T2a below): the title row is dropped; the tab row carries the menu button (first), the workspace tabs, and at its end search, the secondary side bar toggle and the account menu. The layout toggle stays where it was.
  - Hidden (T1 interim, superseded by T2a below): the Full header (both rows) slides over the canvas on reveal; the rail gets a Search item at the top. Until T2a the workspace tabs live in that overlay, so switching workspaces in Hidden needs a reveal (or `Mod+K`).
  - Deviation: the menu button sits at the start of the tab row (this section's T1 plan), not yet at the top of the rail; T3 moves it.

### T2b: persisted workspace order (server, branch `feature/workspace-order`)

**How the order worked before (traced).** The server listed `ORDER BY updated_at DESC` (`Db.list`). The client (`workspaceLifecycle.boot.ts`) takes that array as the tab order and only maps over it afterwards: a save replaces an entry in place, so tabs did not move inside one session. A workspace made through `workspaceLifecycle` is appended (`[...prev, ws]`), the new-workspace dialog in `App.workbench.tsx` prepends it, and a Central create is appended by `addNewWorkspaces`. After a reload every edited board jumped to the front, because saving bumps `updated_at`. That is the instability a manual order cannot have, so the persisted order ignores `updated_at` completely.

**Decision.** A new workspace always goes to the END (the dialog's prepend disagrees with the other two paths and with the rail's "tiles in order, then +"; T2a should append too). `updated_at` and board saves never move a workspace; only `PUT /api/workspaces/order` does. Deleting closes the gap.

**Storage deviates from the brief.** The order is NOT a `position` column on `workspace`; it is a side table `workspace_position (workspace_id PK, position INTEGER NOT NULL)` (`db.order.ts`). Reason: `db.preserveNodes.bun.test.ts` requires the number of `UPDATE|INSERT INTO workspace` statements in `db.ts` to equal the number of `nodesColumn` calls, so a batch reorder as `UPDATE workspace` cannot exist without loosening that policy. The side table also means a reorder rewrites no board row and cannot move `updated_at` (so it never turns another window's unsent save into a 409). Reads join it (`db.row.ts`: `SELECT_WS`/`ORDER_WS`).

**Migration (Rule 4).** `openDb` runs `ensureOrderTable` (`CREATE TABLE/INDEX IF NOT EXISTS`) before the color backfill, then `backfillOrder`: in one `BEGIN IMMEDIATE` it drops rows of vanished workspaces and inserts a position for every workspace lacking one, after the existing ones, in the order users saw until now (`updated_at DESC, id DESC`). Nothing but missing rows is ever written, so a second boot is a no-op and a crash between the steps is repaired by the next boot. Test `db.order.bun.test.ts` boots a legacy file DB twice and reorders in between.

**API contract.**
- `GET /api/workspaces` is `position ASC`; every workspace and every summary carries `position` (0-based, dense, ascending). The summary PAGES (`?summary=1`) keep their `updated_at DESC` keyset because they are a recency view; only the `position` field was added.
- `PUT /api/workspaces/order` body `{ "ids": string[] }` = the complete order. 400 `{ error: "bad_order", reason }` with reason `shape | duplicate | unknown | missing`. Validation and the single batch upsert run in one write transaction; a refusal changes nothing. Success answers the ordered list. A workspace created between the client's read and its PUT is `missing` (400): refetch and retry.
- WS: the existing `{ t:'workspaces' }` (Central create) now carries `order?: string[]` after a reorder. The current client listener ignores the field and only adds missing boards, so T2a must apply `order` to follow other devices.
- Types: `src/shared/workspace.order.ts`; client call `putWorkspaceOrder(ids)` in `src/client/workspaceOrder.api.ts`.
- Central/agent tools: only `workspace.create` makes workspaces and goes through `Db.create`, so it appends. No tool reorders; none added.
- Server fallbacks that took `list()[0]` (`canvasPush` workspace-for-cwd with no active board) now get the first workspace in display order instead of the most recently saved one.

**Not done / debt.** Positions are not pushed on delete (relative order is unchanged, so other windows need nothing). The client wiring landed in T3 (below).

- **T2a done** (branch `feature/rail-workspaces`, client only):
  - Tiles: `WorkspaceRail.tsx` (vertical `tablist`, roving tabindex, Up/Down/Home/End, Enter/Space, `F2` rename, Menu key / `Shift+F10`, `Alt+Shift+Up/Down` reorder, `+`, All workspaces), `WorkspaceRail.tile.tsx` (32px tile, 14px bold monogram, active ring + left bar, agent badge for the open workspace only, worktree dirty marker, tooltip/aria from `workspaceTabFields`), `WorkspaceRail.all.tsx` (quick pick, appears only when the group overflows by fit), `WorkspaceRail.rename.tsx`, `workspaceRail.css`. Compact and Hidden show tiles; Full shows none (App passes the rail props only outside Full).
  - One source for menu/rename/color/`+`: the tab-surface state moved from component state to `workspaceTabUi.store.ts`, so the header strip (Full) and the rail tiles drive the same `WorkspaceBarHosts` (`WorkspaceTabMenu` unchanged). File > Rename edits the tile in Compact/Hidden.
  - Header: Compact is one row (menu button, command pill with the active workspace, layout switch, side bar toggle, account; T3 moved the menu button and account into the rail) with no workspace tabs; Hidden has no tab row at all (the revealed overlay is the title bar, which also carries the layout switch). Switching workspace in Hidden no longer needs a reveal (T1 gap closed). The search icon of the T1 Compact row is gone: the pill is the search button.
  - Rail: Search (Hidden) is its own button above the group; the group sits between it and the tool icons and is the only flexible region (shrinks first, thin scrollbar, `overscroll-behavior: contain`, active cell sticky). Ink on the tile fill is chosen per token in CSS (`oklch(from ...)`, cutoff 0.62, white fallback); `workspaceTiles.test.ts` proves 3:1 for all 36 tokens x 2 themes.
  - Pinned rail: `railLabels.store.ts` (`webterm.railLabels`, per device) sets `data-rail-labels` on `<html>`, which moves `--activity-bar-w` to 220px (every offset that reads the token follows) and shows a name beside every item and tile. Switch in Settings > Appearance ("Show rail labels") and palette command `View: Toggle Rail Labels`. No hover-peek.
  - Reorder: pointer (4px threshold, insertion line, Escape cancels, trailing click swallowed) and keyboard; `workspaceRail.reorder.ts` applies the order optimistically, calls `onReorder(ids)`, and on failure restores the old order and shows an error notice with the cause and Retry. The display order is `position` (ascending) when every workspace carries one, else the received order.
  - Commands: `Workspace: Next` / `Workspace: Previous` (`Mod+Alt+ArrowDown/Up`), registered in every mode.
  - Reorder wiring was left for after T2b; it is done in the T3 branch (see "T3 done").
  - Deviations: the pinned rail applies to the tools and bottom buttons with a CSS `::after` label (a `data-label` attribute on activity items), not a new primitive prop; the rail menu entry for Show labels came with T3 (the menu button was not in the rail yet). `+` is always visible below the tiles (not scrolled with them) so adding a workspace never needs a scroll.

- **T3 done** (branch `feature/rail-menu-t3`, client only; also the reorder wiring T2a left open):
  - Reorder wiring: `workspaceOrder.save.ts` (`useWorkspaceOrderSave`) is the rail's `onReorder`: one `PUT /api/workspaces/order`; when the server answers `bad_order (missing)` (a workspace appeared between the read and the PUT) it refetches the list and retries ONCE with the new ids appended, and a second failure throws a contextual error that the T2a notice shows with Retry. The answer is MERGED into the list (`applyServerOrder`: order + `position`), not swapped in, so a board holding unsent edits keeps them (deviation from the T2a note "returned list replaces the state"). `workspaceList.push.ts` now applies `order` from the pushed `{ t: 'workspaces' }` frame, so other windows follow; the pending optimistic order is dropped when the list order changes (T2a). The new-workspace dialog appends at the END (`appendWorkspace`), like the other two create paths.
  - Menu: the Compact/Hidden app menu is the first control of the rail (`RailChrome.tsx` `RailMenu`, rendered by `Dock` as `railMenu`; `AppMenuButton` opens File / View / Help to the right of the rail). The model is ONE hook, `useWorkspaceMenus`, used by the Full menu bar and the rail button, and App builds its inputs once (`App.menu.ts`) for both doors. View gained **Show Rail Labels** (a checkbox row with the palette chord), so Show labels is in every menu. Lone Alt now works in Hidden: the menu bar is no longer drawn in the (invisible) overlay; the rail button is always visible, and each mode mounts exactly one menu bar, so one Alt handler.
  - Account moved to the rail's bottom group, above Settings (`AccountMenu variant="rail"`, menu opens to the right); the Hidden-only layout switch sits below Settings (`RailLayout`, `aria-pressed`). Compact's single row is now: command pill, layout switch, side bar toggle. The Hidden overlay carries the pill and the side bar toggle only (brand, menu bar, account and layout switch have their rail homes; Full is unchanged). Bottom group extracted to `Dock.modes.tsx` (`Dock.tsx` stays under the limit).
  - Pinned rail (220px): every rail control has a name beside it: activity items (`data-label`), buttons (`aria-label`), tiles and `+`/All (their names), and the menu button (its "Menu" label). `headerRail.inventory.test.tsx` checks that each rail control has an accessible name and one of the pinned-label classes, and that `workspaceRail.css` has the rule for each class.
  - Tests: `headerRail.inventory.test.tsx` mounts header + rail in Full, Compact and Hidden and asserts, per row of the inventory table, where each control is drawn (once per mode), that the three doors list identical menu rows, lone Alt, rail order and handlers. `nativeBranch.policy.test.ts` (registered in `scripts/test.policy.manifest.ts`) scans all of `src/client` and `src/shared`: no native branch, no `-webkit-app-region`.
  - Deviation: F10 as a second key for the menu (row 2 lists Alt only; F10 was never added in T1). Not done.
- **Status**: W0, T1, T2a, T2b and T3 are done. Not done: a native frameless window (decided against for now), hover-peek on the rail (decided against), status badges for inactive workspaces (separate feature). The panel of the rail menu is lifted above the side bar with `:has(...)` while open.
- **Not observed**: no real browser was used for any of it. Verified only by tests and source scans: the reveal timings and the 2px edge, the compact row at narrow widths, the hairline, tile legibility at the real token colors, the sticky active tile at 800px height, the pinned 220px rail, the rail menu panel position and its stacking over the side bar, and `Mod+Shift+H` in Safari/Firefox.


## Rework 2026-11-19

The owner rejected the result above: the screen showed two submenus open on top of each other, rail icons colliding, a tile "L" under the hamburger, and a header that was still there. The order was plain: **remove the header (the title bar row), move the menu to the side rail, keep the workspace tabs.**

### Why the tile / Compact design is replaced

- It answered "slim the header" with a second surface: workspaces became colored tiles in the rail while a Compact row (search pill, layout, side bar toggle) stayed on top. The owner asked for no title row; the pill and account icon were exactly that row.
- Tiles were a new, unfamiliar element. The standard answer in VS Code, Chrome, Arc and Linear is a row of text tabs for open workspaces plus a rail for tools. The tab row already existed and already had the menu, rename, color and drag-order behavior, so the tiles were a fork of it.
- Three modes (Full/Compact/Hidden) were three header layouts to keep correct. Two modes are enough: the row is there, or it is not.

### Final design

- **No title bar in any mode.** The header is one 35px row of workspace tabs (`.app-tabs`): tab per workspace (name, colored dot, status, worktree dirty dot), `+` right after the last tab, drag or Alt+Shift+Left/Right to reorder (saved with `putWorkspaceOrder` through `useWorkspaceOrderSave`, optimistic with rollback and Retry), the same `WorkspaceTabMenu`, inline rename, and at the right end: All workspaces (Chrome's "search tabs", shown from two workspaces), the active worktree's branch, the board layout switch, the side bar toggle.
- **Header modes: `tabs` (default) and `hidden`.** Hidden removes the row from the grid (`--tabbar-h: 0`) and shows it as an overlay at the top edge (`useHeaderReveal`, unchanged). Workspaces stay reachable while it is away: Mod+K, `Workspace: Next/Previous` (Mod+Alt+Down/Up, the arrow names are from the vertical rail and were left alone) and the rail menu. `Mod+Shift+H`, View > Header and Settings > Appearance > Header switch between the two. A stored `full` or `compact` is read as `tabs`; when that happens, one informative notice appears once and the stored value is rewritten (`headerMode.store.ts`, `headerMode.notice.ts`). Tabs is forced while booting and with no workspace.
- **Menu: one hamburger at the top of the rail** (`AppMenuButton`), opening File / View / Help as a cascade drawn by `VscodeMenu`. Before a rail exists (booting, no workspace) the same button is the first control of the tab row, and Account is at its end, so nothing is unreachable on the Welcome screen.
- **Rail, top to bottom:** Menu, Search (opens Go to Anything; the pill is gone), Layers, Sessions, Agent History, Skills, Central, Board, Add node, then the bottom group: Account, Settings, (Hidden only: Toggle tab layout), Lock view, Clean view. No workspace group, no tile, no "All workspaces" in the rail. The pinned rail (220px, labels) is unchanged.

### Root cause of the two defects (Rule 11)

1. **Submenus on top of each other.** Symptom: View and Help open at once, drawn over each other. Cause: `VscodeMenuBar` kept `submenuOpen` as state of each `MenuRow`, so rows of the same panel could not know about each other; opening one never closed another. Each submenu was also placed with CSS (`position: absolute; left: 100%` inside its own row), so there was no collision test and the place depended on whichever rows were open. Fix at the cause: the app menu now uses `VscodeMenu`, which owns ONE `submenuIndex` per panel (opening another closes the first, by construction) and places each submenu with the pure `placeSubmenu` (right of the parent panel, flip left when it does not fit, shift up at the bottom, margin 8px); keyboard (WAI-ARIA menu, roving, type-ahead, Right/Left/Escape) and focus return are the primitive's, and `AppMenuButton` returns focus to its button on any close. `VscodeMenuBar` and its CSS were deleted (no second implementation to drift).
2. **Rail items colliding.** Symptom: the outline icon on top of the `+` of the tile group. Cause: `.vscode-activity-bar` has `height: 100%` and the rail gave it `flex: 1 1 auto`, so its flex basis was the whole rail; with the menu, search, tile group and bottom group around it, the free space went negative and it SHRANK, while its items (`flex: none`) kept their height and overflowed it, unclipped, into the next group. Fix at the cause: the tools group is `flex: 1 0 auto` with `height: auto` (never smaller than its content), the top group and the bottom group are `flex: none`, and `.dock` scrolls (`overflow-y: auto`) instead of overflowing; the bottom group is `position: sticky; bottom: 0` with an opaque background so it stays in view. Every item has the one `--rail-item-h` height and groups use the one `--rail-gap`; nothing in the rail is absolutely positioned. `dock.rail.policy.test.ts` pins all of this.

### What changed in code

- New: `vscodeMenu.place.ts` (pure placement), `vscodeMenu.model.ts` (menu model types and `menusAsRows`), `workspaceTabs.drag.ts` (tab drag), `workspaceCanvas.id.ts`.
- Renamed: `workspaceRail.css` -> `dock.rail.css`, `workspaceRail.order.ts` -> `workspaceOrder.list.ts`, `workspaceRail.reorder.ts` -> `workspaceTabs.reorder.ts`, `WorkspaceRail.all.tsx` -> `WorkspaceBar.all.tsx`, `workspaceRail.policy.test.ts` -> `dock.rail.policy.test.ts`.
- Deleted: `VscodeMenuBar`, `WorkspaceRail*` (tile group, tile, rename popover, keys, overflow), `workspaceTiles.ts` (monogram and tile ink), the title bar, brand, command pill, `CompactTail`, the Full/Compact modes and their CSS.
- API kept: `putWorkspaceOrder`, `useWorkspaceOrderSave`, `useWorkspaceReorder` (now driving the tab row), `WorkspaceTabMenu`, `workspaceTabUi.store`.

### Not observed

No real browser was used. What is verified is structure (DOM order, absence of title bar and tiles, one header region), the pure placement rules, the cascade behavior in jsdom, the stylesheet invariants (one height token, no absolute positioning in the rail, scroll and sticky rules) and the drag/keyboard reorder against a stubbed layout. **Not seen on screen:** the actual look of the cascade next to the rail (jsdom has no layout, so rect-based placement was tested with stubbed rectangles), the rail at short window heights (scroll and the sticky bottom group), the tab row with many tabs and the added controls at narrow widths, `.app-tabs__action` sizing for the shadcn `IconButton` against its `size-6` default (an unlayered override was added; not observed), the Hidden overlay and the edge reveal timing, light and dark themes, and the native window. These need a visual check by the owner.
