/** @vitest-environment jsdom */
// Explorer title bar to VS Code standard: four visible actions + "…" overflow (view options, Upload),
// folder name as title with the full path only in its tooltip, footer count text, per-type icons, compact rows.
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const list = vi.hoisted(() => vi.fn())
vi.mock('./fsClient', async () => ({
  list, mkdir: vi.fn(), write: vi.fn(), stat: vi.fn(), listV2: vi.fn(),
  ...(await import('./filesCaps.fixture')).capsMock(),
  capabilities: async () => (await import('./filesCaps.fixture')).capsWith({ mutate: true, upload: true }),
}))

import FilesNode, { footCount } from './FilesNode'
import { iconClass } from './FilesRow'

afterEach(() => { cleanup(); list.mockReset() })

const PATH = '/Users/bip/Documents/spawn/laya-api' // test-only
const mount = async () => {
  list.mockResolvedValue([{ name: 'src', dir: true }, { name: '.env', dir: false }, { name: 'a.ts', dir: false }])
  const r = render(
    <ReactFlowProvider>
      <FilesNode {...({ id: 'h1', data: { dirPath: PATH }, selected: false } as unknown as ComponentProps<typeof FilesNode>)} />
    </ReactFlowProvider>,
  )
  await waitFor(() => expect(r.container.querySelectorAll('.files-row')).toHaveLength(3))
  return r.container
}

describe('Files title bar', () => {
  it('shows New File, New Folder, Refresh, Collapse All in VS Code order, then the overflow button', async () => {
    const c = await mount()
    const labels = [...c.querySelectorAll('.files-toolbar button')].map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(['New File…', 'New Folder…', 'Refresh Explorer', 'Collapse All', 'More Actions…'])
    expect(c.querySelector('[aria-label="Hide hidden files"], [aria-label="Sort"]')).toBeNull()
  })

  it('overflow menu holds hidden files, sort and Upload, toggles as checkmarks', async () => {
    const c = await mount()
    fireEvent.click(c.querySelector('[aria-label="More Actions…"]') as HTMLElement)
    const hidden = await screen.findByRole('menuitemcheckbox', { name: /Show Hidden Files/ })
    expect(hidden.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemcheckbox', { name: /Sort by Name/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemcheckbox', { name: /Sort by Size/ }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('menuitemcheckbox', { name: /Ascending/ })).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: /Upload Files…/ })).toBeTruthy())
  })

  it('New File opens the inline name input in the tree', async () => {
    const c = await mount()
    fireEvent.click(c.querySelector('[aria-label="New File…"]') as HTMLElement)
    expect(await screen.findByRole('textbox', { name: 'New file name' })).toBeTruthy()
  })

  it('title is the folder name; the absolute path is not header text, only the title tooltip', async () => {
    const c = await mount()
    const header = c.querySelector('.node-header') as HTMLElement
    expect(header.querySelector('.node-title')?.textContent).toBe('laya-api')
    expect(header.textContent).not.toContain(PATH)
    expect(header.querySelector('.node-description')).toBeNull()
    expect(header.querySelector('.node-title')?.getAttribute('title')).toContain(PATH)
  })

  it('footer says "N items" unfiltered', async () => {
    const c = await mount()
    expect(c.querySelector('.files-foot')?.textContent).toBe('3 items')
  })

  it('rows carry the compact class', async () => {
    const c = await mount()
    for (const r of c.querySelectorAll('.files-row')) expect(r.classList.contains('files-row--compact')).toBe(true)
  })
})

describe('footCount', () => {
  it('unfiltered: item count (singular/plural); filtered: "x of y shown"', () => {
    expect(footCount(10, 10, '')).toBe('10 items')
    expect(footCount(1, 1, '  ')).toBe('1 item')
    expect(footCount(3, 10, 'src')).toBe('3 of 10 shown')
  })
})

describe('row icons', () => {
  it('distinct glyph or tone per common type; folders by state', () => {
    expect(iconClass(false, false, 'a.ts')).toBe('codicon codicon-file-code files-icon files-icon--blue')
    expect(iconClass(false, false, 'a.js')).toBe('codicon codicon-file-code files-icon files-icon--yellow')
    expect(iconClass(false, false, 'p.json')).toBe('codicon codicon-json files-icon files-icon--yellow')
    expect(iconClass(false, false, 'R.md')).toBe('codicon codicon-markdown files-icon files-icon--blue')
    expect(iconClass(false, false, 'ci.yml')).toBe('codicon codicon-settings-gear files-icon files-icon--purple')
    expect(iconClass(false, false, '.env.local')).toBe('codicon codicon-key files-icon files-icon--yellow')
    expect(iconClass(false, false, '.gitignore')).toBe('codicon codicon-source-control files-icon files-icon--orange')
    expect(iconClass(false, false, 'logo.png')).toBe('codicon codicon-file-media files-icon files-icon--purple')
    expect(iconClass(false, false, 'Makefile')).toBe('codicon codicon-file files-icon')
    expect(iconClass(true, false, 'src')).toBe('codicon codicon-folder files-icon')
    expect(iconClass(true, true, 'src')).toBe('codicon codicon-folder-opened files-icon')
  })
})
