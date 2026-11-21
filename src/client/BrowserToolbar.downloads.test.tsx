/** @vitest-environment jsdom */
// Downloads in the toolbar (Chrome placement): right of the omnibox/agent group, just before ⋮; hidden until there is history;
// the ⋮ menu row opens the same list; never in the node header.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { DownloadItem } from '../shared/browser.downloads'
import BrowserToolbar from './BrowserToolbar'
import { TOOLBAR_TEXT } from './browser.uxText'
import { DL_TEXT } from './browserDownloads/browserDownloads.text'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const item = (o: Partial<DownloadItem> & { id: string }): DownloadItem => ({
  nodeId: 'n1', name: `${o.id}.zip`, url: 'https://cdn.example/f', host: 'cdn.example', received: 0, total: 0, state: 'inProgress', risky: false, startedAt: 1, ...o,
})
const mount = (items: DownloadItem[]) => render(
  <BrowserToolbar nav={vi.fn()} agentControl agentEnabled onAgentControl={vi.fn()} downloads={{ nodeId: 'n1', items }} />,
)
const kebab = () => screen.getByRole('button', { name: TOOLBAR_TEXT.more })

describe('toolbar Downloads button', () => {
  it('sits in the toolbar immediately before the ⋮ button, after the agent toggle', () => {
    mount([item({ id: 'a', state: 'completed', received: 5, total: 5 })])
    const toolbar = screen.getByRole('toolbar')
    const btn = screen.getByRole('button', { name: 'Downloads' })
    expect(toolbar.contains(btn)).toBe(true)
    const agent = screen.getByRole('button', { name: TOOLBAR_TEXT.agentPill })
    expect(agent.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const all = [...toolbar.querySelectorAll<HTMLElement>('button')]
    expect(all.indexOf(kebab())).toBe(all.indexOf(btn) + 1)
  })

  it('keeps the badge and progress ring while a file transfers', () => {
    mount([item({ id: 'a', received: 25, total: 100 })])
    expect(screen.getByRole('button', { name: DL_TEXT.buttonActive(1) })).toBeTruthy()
    expect(document.querySelector('.bdl-badge')?.textContent).toBe('1')
    expect(document.querySelector('.bdl-ring')).toBeTruthy()
  })

  it('is hidden with no history (width collapsed, no button) and the ⋮ row opens the same list', () => {
    mount([])
    expect(screen.queryByRole('button', { name: /^Downloads/ })).toBeNull()
    expect(document.querySelector('[data-browser-downloads]')?.getAttribute('data-shown')).toBe('false')
    fireEvent.click(kebab())
    fireEvent.click(screen.getByRole('menuitem', { name: DL_TEXT.button }))
    expect(screen.getByRole('dialog', { name: 'Downloads' })).toBeTruthy()
    expect(screen.getByText(DL_TEXT.empty)).toBeTruthy()
  })

  it('ignores downloads of other nodes when deciding to show the button', () => {
    mount([item({ id: 'x', nodeId: 'other' })])
    expect(screen.queryByRole('button', { name: /^Downloads/ })).toBeNull()
  })

  it('is not wired into the node header any more', () => {
    const src = readFileSync(`${import.meta.dirname}/BrowserNode.tsx`, 'utf8')
    expect(src).not.toMatch(/BrowserDownloads\b/)
    expect(src).toMatch(/extraHeader=\{<>(\{showAudio && <BrowserAudioButton .*?\/>\})?<BrowserProfileChip/) // the header holds the audio button and the profile chip, nothing download-related
  })
})
