# VS Code Elements foundation

Adapter layer over [`@vscode-elements/react-elements`](https://vscode-elements.github.io)
v2.4.0. It is the import surface and theme bridge: screens such as `FindBar`,
`NodeChrome`, `NodeToolbar`, `FilesNode`, `EditorNode`, `SessionRow` and
`SessionsPanel` already use the wrappers re-exported from `register.ts`.

- `register.ts` imports the package once (registering every `vscode-*` custom
  element) and re-exports the React wrappers under short names.
- `vscode-theme.css` maps the webterm design tokens in `styles.css` onto the
  `--vscode-*` variables the components read.
- `test-setup.ts` patches the `ElementInternals` methods jsdom lacks.
- `foundation.test.tsx` smoke-tests one wrapper per family.

## Usage

```tsx
import { Button, Textfield, Tabs, TabHeader, TabPanel } from '@/vscode/register'

<Button secondary>Cancel</Button>
<Textfield placeholder="Search" />
<Tabs>
  <TabHeader slot="header">Terminal</TabHeader>
  <TabPanel>…</TabPanel>
</Tabs>
```

`main.tsx` imports `vscode-theme.css` before `index.css`/`styles.css` and imports
`register` once. Do not import `@vscode-elements/react-elements` directly in
screens; going through `register.ts` keeps a future library swap local.

## Covered components

Badge, Button, ButtonGroup, Checkbox, CheckboxGroup, Collapsible, ContextMenu,
ContextMenuItem, Divider, FormContainer, FormGroup, FormHelper, Icon, Label,
MultiSelect, Option, ProgressBar, ProgressRing, Radio, RadioGroup, Scrollable,
SingleSelect, SplitLayout, TabHeader, TabPanel, Tabs, Table (plus Body, Cell,
Header, HeaderCell, Row), Textarea, Textfield, ToolbarButton, ToolbarContainer,
Tree, TreeItem.

## Not provided by the library

These have no component in v2.4.0 and must stay on existing webterm/Radix
implementations or be built locally:

- Dialog
- Sheet
- Popover
- DropdownMenu
- Tooltip
- Card
- Switch
- Command palette
- StatusBar
- ActivityBar

## Theme

All `--vscode-*` variables derive from existing tokens (`--bg`, `--panel`,
`--text`, `--accent`, …) so dark and light stay in sync. Alpha variants use
`color-mix()`. The `[data-theme='light']` block only adjusts alphas that read too
faint on the warm light surface.

## Known gaps

- **Icons need the codicon stylesheet.** `Icon` looks for a `<link>` with
  `id="vscode-codicon-stylesheet"` (the codicon font/CSS is not bundled by the
  package). Without it, icons log a warning and render empty. Nothing in webterm
  provides that link yet; add `@vscode/codicons` (or a local copy) when a screen
  first uses `Icon`.
- **Tests do not see wrapper-applied props.** Vitest resolves `@lit/react`'s
  `node` export condition, whose SSR build only forwards props via
  `_$litProps$`. Components still mount and upgrade, so the smoke test asserts
  registration, light-DOM text/roles, and property reactivity instead of React
  prop forwarding.
- Everything in `register.ts` is imported eagerly, so the bundle includes every
  component even if unused. Revisit with per-component entry points if the
  bundle grows noticeably.
