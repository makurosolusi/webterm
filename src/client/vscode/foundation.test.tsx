/**
 * @vitest-environment jsdom
 */
// Foundation smoke test: proves every exported wrapper mounts, upgrades to its custom
// element, and keeps light-DOM text/roles. That is exactly the wiring this module owns.
//
// Vitest resolves @lit/react's `node` export condition, whose SSR build forwards React
// props through `_$litProps$` only; element properties are therefore not applied in
// jsdom (the browser build does that in a layout effect). The test asserts property
// reactivity directly where it matters rather than pretending the wrapper applied it.
// Shadow-DOM internals stay out of scope: jsdom does not lay them out.
import './test-setup'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Button,
  ContextMenu,
  TabHeader,
  TabPanel,
  Tabs,
  Textfield,
  Tree,
  TreeItem,
} from './register'

afterEach(cleanup)

function host<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  const el = document.querySelector(tag)
  if (!el) throw new Error(`expected <${tag}> to be rendered`)
  return el as HTMLElementTagNameMap[K]
}

function expectUpgraded(tag: string, el: Element): void {
  const ctor = customElements.get(tag)
  expect(ctor, `<${tag}> should be registered`).toBeDefined()
  expect(el).toBeInstanceOf(ctor)
}

describe('vscode-elements foundation', () => {
  it('renders a button with its label and button role', () => {
    render(<Button>Save</Button>)

    const button = host('vscode-button') as HTMLElement & { role: string }
    expectUpgraded('vscode-button', button)
    expect(button.role).toBe('button')
    expect(button.textContent).toBe('Save')
  })

  it('renders a textfield whose value property is reactive', () => {
    render(<Textfield />)

    const field = host('vscode-textfield') as HTMLElement & { value: string }
    expectUpgraded('vscode-textfield', field)
    expect(field.value).toBe('')
    field.value = 'webterm'
    expect(field.value).toBe('webterm')
  })

  it('renders tabs with a header and panel in light DOM', () => {
    render(
      <Tabs>
        <TabHeader slot="header">Terminal</TabHeader>
        <TabPanel>Session output</TabPanel>
      </Tabs>,
    )

    const tabs = host('vscode-tabs') as HTMLElement & { selectedIndex: number }
    expectUpgraded('vscode-tabs', tabs)
    expect(tabs.selectedIndex).toBe(0)
    expect(host('vscode-tab-header').textContent).toBe('Terminal')
    expect(host('vscode-tab-panel').textContent).toBe('Session output')
    expect(screen.getByText('Terminal')).toBeTruthy()
  })

  it('renders tree items as light-DOM children with treeitem roles', () => {
    render(
      <Tree>
        <TreeItem>src</TreeItem>
        <TreeItem>main.tsx</TreeItem>
      </Tree>,
    )

    expectUpgraded('vscode-tree', host('vscode-tree'))
    const items = document.querySelectorAll('vscode-tree-item')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toBe('src')
    expect(items[0]?.getAttribute('role')).toBe('treeitem')
    expect(items[1]?.textContent).toBe('main.tsx')
  })

  it('renders a context menu and exposes its data property', () => {
    render(<ContextMenu />)

    const menu = host('vscode-context-menu') as HTMLElement & {
      data: Array<{ label: string; value: string }>
    }
    expectUpgraded('vscode-context-menu', menu)
    expect(menu.data).toEqual([])

    menu.data = [{ label: 'Copy', value: 'copy' }]
    expect(menu.data).toEqual([{ label: 'Copy', value: 'copy' }])
  })
})
