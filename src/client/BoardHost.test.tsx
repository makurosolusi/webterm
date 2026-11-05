/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import BoardHost from './BoardHost'
import { connectTabLayout, setMode } from './tabLayout.store'

const mounts = vi.hoisted(() => ({ n: 0 }))
vi.mock('./App.canvas', async () => {
  const { useEffect } = await import('react')
  return { default: () => { useEffect(() => { mounts.n++ }, []); return <div data-testid="canvas" /> } }
})

const tabs = {
  nodes: [], statuses: {}, onCloseNode: vi.fn(), onRenameNode: vi.fn(),
  onAddTerminal: vi.fn(), onAddAgent: vi.fn(), onAddDiff: vi.fn(), onAddFiles: vi.fn(),
}
const host = () => screen.getByTestId('canvas').parentElement!

beforeEach(() => { mounts.n = 0; connectTabLayout(defaultTabLayout(), null) })
afterEach(cleanup)

describe('BoardHost', () => {
  it('canvas mode renders the canvas visible and no TabsView', () => {
    render(<BoardHost canvas={{} as never} tabs={tabs} />)
    expect(host().dataset.mode).toBe('canvas')
    expect(host().hasAttribute('aria-hidden')).toBe(false)
    expect(document.querySelector('.tabs-view')).toBeNull()
  })

  it('toggling modes hides the canvas (not unmounts it) and mounts TabsView', () => {
    render(<BoardHost canvas={{} as never} tabs={tabs} />)
    const canvas = screen.getByTestId('canvas')
    act(() => setMode('tabs'))
    expect(screen.getByTestId('canvas')).toBe(canvas)
    expect(host().dataset.mode).toBe('tabs')
    expect(host().getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('.tabs-view')).not.toBeNull()
    act(() => setMode('canvas'))
    expect(screen.getByTestId('canvas')).toBe(canvas)
    expect(mounts.n).toBe(1)
    expect(document.querySelector('.tabs-view')).toBeNull()
  })

  it('hides via CSS visibility, never display:none', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(`${process.cwd()}/src/client/tab-layout.css`, 'utf8')
    const rule = /\.board-host\[data-mode='tabs'\]\s*\{([^}]*)\}/.exec(css)![1]
    expect(rule).toContain('visibility: hidden')
    expect(rule).toContain('pointer-events: none')
    expect(rule).not.toContain('display')
  })
})
