// test-only: the one header every node kind shares (NodeChrome), asserted the same way for the editor,
// diff, plan and MCP app nodes that used to carry their own header and a resize-mode button.
import { act, fireEvent } from '@testing-library/react'
import { expect } from 'vitest'

const titles = (header: Element) => [...header.querySelectorAll('.node-toolbar vscode-toolbar-button')].map((b) => b.getAttribute('data-title'))

/** `nodeEl` (a `.react-flow__node`) has the shared header, edge resize, and "…" with Rename… and Node color…. */
export function expectSharedChrome(nodeEl: HTMLElement): void {
  const header = nodeEl.querySelector('.node-header')
  expect(header, 'NodeChrome header').not.toBeNull()
  // Edges and corners resize from invisible strips; no header carries a resize-mode button.
  expect(nodeEl.querySelectorAll('.react-flow__resize-control.node-edge-resize')).toHaveLength(8)
  expect(nodeEl.querySelector('.node-resize-toggle, .codicon-arrow-both')).toBeNull()
  expect(titles(header!)).toEqual(['Maximize', 'More Actions…', 'Close'])
  expect(header!.querySelector('[data-title="Collapse"]')).not.toBeNull()
  // Every icon in the header has a shadcn tooltip, never a native title.
  for (const b of header!.querySelectorAll('vscode-toolbar-button, button')) expect(b.hasAttribute('title'), b.outerHTML.slice(0, 80)).toBe(false)
  fireEvent.click(header!.querySelector('[data-title="More Actions…"]')!)
  const rows = [...document.querySelectorAll('[role^="menuitem"]')].map((r) => r.textContent)
  expect(rows).toEqual(expect.arrayContaining(['Comments', 'Rename…', 'Node color…']))
  // Rename… opens the title field in place, as a click on the title does.
  act(() => { fireEvent.click([...document.querySelectorAll('[role^="menuitem"]')].find((r) => r.textContent === 'Rename…')!) })
  expect(header!.querySelector('.node-title--edit')).not.toBeNull()
}
