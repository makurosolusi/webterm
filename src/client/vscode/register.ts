/**
 * VS Code Elements foundation.
 *
 * Importing this module registers every `vscode-*` custom element and re-exports the
 * React wrappers under short names. Screens should import components from here, not
 * from the package directly, so a future swap of the underlying library stays local.
 *
 * Note: all wrappers are imported eagerly. Tree-shaking is limited by the library's
 * side-effect registration; splitting is deferred until a screen actually needs it.
 */
export {
  VscodeBadge as Badge,
  VscodeButton as Button,
  VscodeButtonGroup as ButtonGroup,
  VscodeCheckbox as Checkbox,
  VscodeCheckboxGroup as CheckboxGroup,
  VscodeCollapsible as Collapsible,
  VscodeContextMenu as ContextMenu,
  VscodeContextMenuItem as ContextMenuItem,
  VscodeDivider as Divider,
  VscodeFormContainer as FormContainer,
  VscodeFormGroup as FormGroup,
  VscodeFormHelper as FormHelper,
  VscodeIcon as Icon,
  VscodeLabel as Label,
  VscodeMultiSelect as MultiSelect,
  VscodeOption as Option,
  VscodeProgressBar as ProgressBar,
  VscodeProgressRing as ProgressRing,
  VscodeRadio as Radio,
  VscodeRadioGroup as RadioGroup,
  VscodeScrollable as Scrollable,
  VscodeSingleSelect as SingleSelect,
  VscodeSplitLayout as SplitLayout,
  VscodeTabHeader as TabHeader,
  VscodeTable as Table,
  VscodeTableBody as TableBody,
  VscodeTableCell as TableCell,
  VscodeTableHeader as TableHeader,
  VscodeTableHeaderCell as TableHeaderCell,
  VscodeTableRow as TableRow,
  VscodeTabPanel as TabPanel,
  VscodeTabs as Tabs,
  VscodeTextarea as Textarea,
  VscodeTextfield as Textfield,
  VscodeToolbarButton as ToolbarButton,
  VscodeToolbarContainer as ToolbarContainer,
  VscodeTree as Tree,
  VscodeTreeItem as TreeItem,
} from '@vscode-elements/react-elements'

export type { VscContextMenuSelectEvent } from '@vscode-elements/elements/dist/vscode-context-menu/vscode-context-menu.js'
export type { VscTabsSelectEvent } from '@vscode-elements/elements/dist/vscode-tabs/vscode-tabs.js'
export type { VscTreeSelectEvent } from '@vscode-elements/elements/dist/vscode-tree/vscode-tree.js'
