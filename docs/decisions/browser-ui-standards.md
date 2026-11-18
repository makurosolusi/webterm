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
| `--bui-focus` | 2px | keyboard focus outline |

Contrast: use VS Code theme tokens (`--vscode-*`) only, no new hex values, so dark and light themes stay consistent.

## Components

- Buttons: `<Button size="bui">` (28px, 13px text) and `<IconButton size="icon-bui">` (28x28, 16px icon). `xs`, `icon-xs` are banned in browser UI.
- Dialogs and popovers: padding 16px, body 13px, buttons `bui`.
- Narrow nodes (240-400px): container queries in `browser.css` drop forward (360px), the agent toggle (300px) and in-field extras (260px). Each one is still in the ⋮ menu (`BrowserToolbarMenu`), so no feature disappears. A new secondary control must have a menu row too.

## Guard

`src/client/browserUi.metrics.test.ts` fails on font sizes under 12px, `xs`/`icon-xs` controls and missing `--bui-*` tokens in the browser files. It has no exception list. Excluded from the scan, pending a second pass: `browserSplit/`, the tab strip (`BrowserTabStrip*`, `BrowserTabItem`, `browserTabs.css`) and `BrowserNewTabPage`.

## Adding a component

Use the tokens and sizes above, name every icon-only button (`IconButton` requires `label`), and add the control to the ⋮ menu if it can be hidden on narrow nodes.

## Not covered

App-wide chrome tokens (`--ui-font-size-label: 11px` in `styles.css`, node header status chip) are shared with other node kinds. Canvas zoom scales the whole node, so text is logical px; it cannot be made readable below the user's zoom level.
