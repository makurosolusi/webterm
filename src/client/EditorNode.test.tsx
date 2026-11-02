/** @vitest-environment jsdom */
// Chrome editor node: ikon file, titik "dirty" (bukan teks ●), tema Monaco mengikuti data-theme.
// Monaco dipalsukan — yang diuji kabel React-nya, bukan Monaco.
import type { ComponentProps } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const fake = vi.hoisted(() => {
  const state = { value: 'a', onChange: () => {}, setTheme: vi.fn(), createdWith: null as unknown }
  const editor = {
    getValue: () => state.value,
    onDidChangeModelContent: (cb: () => void) => { state.onChange = cb },
    addCommand: () => {},
    dispose: () => {},
  }
  const monaco = {
    Uri: { file: () => ({ with: () => 'uri' }) },
    KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 },
    editor: {
      getModel: () => null,
      createModel: () => ({ dispose: () => {} }),
      create: (_h: unknown, opts: unknown) => { state.createdWith = opts; return editor },
      setTheme: state.setTheme,
    },
  }
  return { state, monaco }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => Promise.resolve(fake.monaco) }))

import EditorNode from './EditorNode'

afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-theme') })

function mount() {
  const props = {
    id: 'n1', data: { filePath: '/x/app.json' }, selected: false,
    read: () => Promise.resolve('a'), write: () => Promise.resolve(true), readBinary: () => Promise.resolve(''),
  }
  return render(<ReactFlowProvider><EditorNode {...(props as unknown as ComponentProps<typeof EditorNode>)} /></ReactFlowProvider>)
}

describe('EditorNode chrome', () => {
  it('menampilkan ikon codicon per ekstensi, dirty dot saat berubah, dan tema VS Code', async () => {
    const { container } = mount()
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    expect(container.querySelector('.editor-node__icon')?.className).toContain('codicon-json')
    expect(fake.state.createdWith).toMatchObject({ theme: 'webterm-dark-modern', minimap: { enabled: false } })

    expect(screen.queryByRole('img', { name: 'Unsaved changes' })).toBeNull()
    fake.state.value = 'ab'
    act(() => fake.state.onChange())
    expect(screen.getByRole('img', { name: 'Unsaved changes' }).className).toContain('codicon-circle-filled')
    expect(container.querySelector('.editor-node__name')?.textContent).not.toContain('●')
  })

  it('menampilkan breadcrumb path dan tidak lagi memaksa border atas berwarna swatch', async () => {
    const { container } = mount()
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    const crumbs = container.querySelector('nav.editor-node__crumbs, .editor-node__crumbs')
    expect(crumbs?.getAttribute('aria-label')).toBe('File path')
    expect(crumbs?.textContent).toContain('x')
    expect(crumbs?.textContent).toContain('app.json')
    expect(container.querySelector('.term-node')?.className).not.toContain('border-top-color')
  })

  it('mengganti tema Monaco saat data-theme berubah', async () => {
    mount()
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    document.documentElement.setAttribute('data-theme', 'light')
    await waitFor(() => expect(fake.state.setTheme).toHaveBeenCalledWith('webterm-light-modern'))
  })
})
