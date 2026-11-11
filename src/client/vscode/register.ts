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
import * as Lit from '@vscode-elements/react-elements'
import { keepRefCleanup } from './refCleanup'

// Every wrapper goes through `keepRefCleanup`: `@lit/react` drops a ref callback's cleanup (see refCleanup.ts).
export const Badge = keepRefCleanup(Lit.VscodeBadge)
export const Button = keepRefCleanup(Lit.VscodeButton)
export const ButtonGroup = keepRefCleanup(Lit.VscodeButtonGroup)
export const Checkbox = keepRefCleanup(Lit.VscodeCheckbox)
export const CheckboxGroup = keepRefCleanup(Lit.VscodeCheckboxGroup)
export const Collapsible = keepRefCleanup(Lit.VscodeCollapsible)
export const ContextMenu = keepRefCleanup(Lit.VscodeContextMenu)
export const ContextMenuItem = keepRefCleanup(Lit.VscodeContextMenuItem)
export const Divider = keepRefCleanup(Lit.VscodeDivider)
export const FormContainer = keepRefCleanup(Lit.VscodeFormContainer)
export const FormGroup = keepRefCleanup(Lit.VscodeFormGroup)
export const FormHelper = keepRefCleanup(Lit.VscodeFormHelper)
export const Icon = keepRefCleanup(Lit.VscodeIcon)
export const Label = keepRefCleanup(Lit.VscodeLabel)
export const MultiSelect = keepRefCleanup(Lit.VscodeMultiSelect)
export const Option = keepRefCleanup(Lit.VscodeOption)
export const ProgressBar = keepRefCleanup(Lit.VscodeProgressBar)
export const ProgressRing = keepRefCleanup(Lit.VscodeProgressRing)
export const Radio = keepRefCleanup(Lit.VscodeRadio)
export const RadioGroup = keepRefCleanup(Lit.VscodeRadioGroup)
export const Scrollable = keepRefCleanup(Lit.VscodeScrollable)
export const SingleSelect = keepRefCleanup(Lit.VscodeSingleSelect)
export const SplitLayout = keepRefCleanup(Lit.VscodeSplitLayout)
export const TabHeader = keepRefCleanup(Lit.VscodeTabHeader)
export const Table = keepRefCleanup(Lit.VscodeTable)
export const TableBody = keepRefCleanup(Lit.VscodeTableBody)
export const TableCell = keepRefCleanup(Lit.VscodeTableCell)
export const TableHeader = keepRefCleanup(Lit.VscodeTableHeader)
export const TableHeaderCell = keepRefCleanup(Lit.VscodeTableHeaderCell)
export const TableRow = keepRefCleanup(Lit.VscodeTableRow)
export const TabPanel = keepRefCleanup(Lit.VscodeTabPanel)
export const Tabs = keepRefCleanup(Lit.VscodeTabs)
export const Textarea = keepRefCleanup(Lit.VscodeTextarea)
export const Textfield = keepRefCleanup(Lit.VscodeTextfield)
export { ToolbarButton } from './toolbarButton'
export const ToolbarContainer = keepRefCleanup(Lit.VscodeToolbarContainer)
export const Tree = keepRefCleanup(Lit.VscodeTree)
export const TreeItem = keepRefCleanup(Lit.VscodeTreeItem)

export type { VscContextMenuSelectEvent } from '@vscode-elements/elements/dist/vscode-context-menu/vscode-context-menu.js'
export type { VscTabsSelectEvent } from '@vscode-elements/elements/dist/vscode-tabs/vscode-tabs.js'
export type { VscTreeSelectEvent } from '@vscode-elements/elements/dist/vscode-tree/vscode-tree.js'
