# Browser UI standards

Why: browser node controls were 20px (`icon-xs`/`xs`), 11-12px text and 25px omnibox, below Chrome, VS Code and WCAG 2.2 norms.

## Numbers (single source: `src/client/browserUi.css`)

| Token | Value | Use |
| --- | --- | --- |
| `--bui-icon` | 16px | functional icons (toolbar, menus, dialogs) |
| `--bui-hit` | 28px | minimum interactive target (WCAG 2.2 AA asks 24px) |
| `--bui-font` | 13px | body text and controls |
| `--bui-font-sm` | 12px | secondary text, labels, badges. Nothing below 12px |
| `--bui-toolbar-h` | 36px | toolbar row (28px controls + 4px padding) |
| `--bui-omnibox-h` | 28px | address field, 13px text |
| `--bui-gap` | 4px | spacing between controls |
| `--bui-focus` | 2px | keyboard focus outline, active-tab bar, focused-pane edge |
| `--bui-tab-h` | 36px | tab strip row (Chrome: 34-36px) |
| `--bui-tab-min-w` / `--bui-tab-max-w` | 112px / 220px | tab width: tabs share the row up to the max, shrink to the min, then the list scrolls |
| `--bui-pane-head-h` | 32px | split-pane header (13px title, 16px icons in 28px buttons) |
| `--bui-close` | 24px | tab close target around a 16px icon (WCAG 2.5.8 minimum; the whole tab is the 36px target) |

Contrast: use VS Code theme tokens (`--vscode-*`) only, no new hex values, so dark and light themes stay consistent.

## Tab strip, pane header, separators (second pass)

- Overflow: past the min width the list scrolls; chevrons and **All tabs** (menu of every tab) appear, so no tab is unreachable. Keyboard: arrows, Home/End, Enter/Space, Delete.
- Pane header priority, decided by the pane's own width (container query `bp` in `browserSplit.css`): title + device + Close always stay; the size readout goes below 260px, the grip below 160px (the whole header remains the drag handle, and the right-click menu offers Move/Swap).
- Separator (sash): 8px hit area, 2px line, 4px on hover/focus/drag (keep `HALF` in `BrowserSeparator.tsx` in sync).
- Hover, active and focus use the same tokens everywhere: 2px outline for focus, 2px top bar for the active tab.

## Node header

The header says one title and one host. A page title that is only a URL is shown as its host, with the full URL in the tooltip (`browser.header.ts`; the tab strip applies the same rule in `tabTitle`). A user-chosen node title wins and the host follows it. The trailing chip ("baru" in a screenshot) is the **browser profile** (a user-named profile, not a status); it now carries an account icon and its tooltip says "Profile ...".

## Agent marker (robot on a tab)

Shown only while the agent holds the browser (lease = agent) and only on the agent's tab (`agentTabId`) or a tab it opened (`tab.agent`). `agentTabId` alone defaults to the first tab of every node, so on a node a human opened it claimed something false. When the lease is released the marker disappears (rule: marker = live lease, `isAgentTab` in `browserTabs.labels.ts`). The tab's accessible name drops "agent working here" at the same time.

## Click vs drag on nodes

`<ReactFlow nodeClickDistance={NODE_CLICK_DISTANCE}>` (4px, `canvas.clickDistance.ts`). React Flow runs d3-drag on every node and d3-drag swallows the `click` after any pointer movement over its `clickDistance` (default 0) unless the target is inside `nodrag`; a 1px wobble killed clicks. Now up to 4px of travel is still a click, on all node kinds (terminal, agent, editor, browser). A longer movement is still a drag and still swallows the click; drag start (`nodeDragThreshold`), selection and pan are separate settings and unchanged. Pinned by `canvas.clickDistance.test.tsx`.

## Components

- Buttons: `<Button size="bui">` (28px, 13px text) and `<IconButton size="icon-bui">` (28x28, 16px icon). `xs`, `icon-xs` are banned in browser UI.
- Dialogs and popovers: padding 16px, body 13px, buttons `bui`.
- Narrow nodes (240-400px): container queries in `browser.css` drop forward (360px), the agent toggle (300px) and in-field extras (260px). Each one is still in the ⋮ menu (`BrowserToolbarMenu`), so no feature disappears. A new secondary control must have a menu row too.

## Guard

`src/client/browserUi.metrics.test.ts` fails on font sizes under 12px, `xs`/`icon-xs` controls and missing `--bui-*` tokens in the browser files. It has no exception list: the tab strip, `browserSplit/` and `BrowserNewTabPage` are scanned like everything else (only `*.test.*` and `*.fake.*` files are skipped). It also requires tokenised fonts in `browserTabs.css`/`browserSplit.css` (literal px only for 14px+ page inputs) and `bui`/`icon-bui` sizes in those folders.

## Adding a component

Use the tokens and sizes above, name every icon-only button (`IconButton` requires `label`), and add the control to the ⋮ menu if it can be hidden on narrow nodes.

## Not covered

App-wide chrome tokens (`--ui-font-size-label: 11px` in `styles.css`, node header status chip) are shared with other node kinds. Canvas zoom scales the whole node, so text is logical px; it cannot be made readable below the user's zoom level.
