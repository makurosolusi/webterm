/** @vitest-environment jsdom */
// Locks two root causes of the node header bugs:
// 1. A node "Full Screen" called the browser Fullscreen API and covered the whole monitor; Maximize
//    now fills the canvas pane only, so nothing in the client may request the OS full screen.
// 2. Two near-identical squares (Full Screen + Stop agent) sat side by side; a destructive action
//    looked like a layout one. No two visible header buttons may come from one confusable icon group.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import NodeChrome from './NodeChrome'

// NodeChrome reads its node id from React Flow; outside a flow there is none, so give it one.
vi.mock('@xyflow/react', async (orig) => ({ ...(await orig<typeof import('@xyflow/react')>()), useNodeId: () => 'n1' }))

const clientRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(clientRoot, '../..')

/** Files allowed to call the Fullscreen API, with a reason. Empty: maximize never leaves the canvas pane. */
const FULLSCREEN_ALLOWLIST: Record<string, string> = {}

/** Icons that read as "a square" at toolbar size; `screen-full`/`screen-normal` are one toggle, counted once. */
const CONFUSABLE_GROUPS = [
  ['chrome-maximize', 'chrome-restore', 'debug-stop', 'primitive-square', 'stop', 'stop-circle', 'square'],
  ['screen-full', 'screen-normal'],
]

/** Destructive header controls and the consequence their tooltip must name. */
const DESTRUCTIVE: Record<string, RegExp> = {
  'Stop Agent (keeps the node)': /keeps the node/,
  'Close (ends the session)': /ends the session/,
}

async function sourcesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? sourcesUnder(p) : /\.(tsx?|css)$/.test(e.name) ? [p] : []
  }))
  return files.flat()
}

const base = {
  title: 'agent', onRename: () => {}, collapsed: false, onToggleCollapse: () => {}, color: '#fff', onColor: () => {},
  comments: [], onAddComment: () => {}, onRefresh: () => {}, searchOpen: false, onToggleSearch: () => {}, onClose: () => {},
}
const headerButtons = (c: HTMLElement) => [...c.querySelectorAll('.node-header vscode-toolbar-button, .node-header button')]
  .map((b) => ({ title: b.getAttribute('data-title') ?? b.getAttribute('aria-label') ?? '', icon: b.querySelector('.codicon')?.className.match(/codicon-([\w-]+)/)?.[1] }))

afterEach(cleanup)

describe('node full screen policy', () => {
  it('has no requestFullscreen anywhere under src/client outside the allowlist', async () => {
    const hits: string[] = []
    for (const file of (await sourcesUnder(clientRoot)).filter((f) => !/\.test\.tsx?$/.test(f)).sort()) {
      const rel = path.relative(repoRoot, file)
      if (!FULLSCREEN_ALLOWLIST[rel] && /requestFullscreen/.test(await readFile(file, 'utf8'))) hits.push(rel)
    }
    expect(hits, `Fullscreen API used in:\n${hits.join('\n')}`).toEqual([])
  })
})

describe('node header icon policy', () => {
  // Every optional header control wired, in both Maximize states, so nothing hides a clash.
  it.each([false, true])('no two visible header buttons share a confusable icon group (agent running, collapsed=%s)', (collapsed) => {
    const { container } = render(<NodeChrome {...base} collapsed={collapsed} onStop={() => {}} onToggleMic={() => {}} onAiName={() => {}} />)
    const buttons = headerButtons(container)
    expect(buttons.map((b) => b.title)).toEqual(expect.arrayContaining(['Maximize', 'Stop Agent (keeps the node)', 'Close (ends the session)']))
    for (const group of CONFUSABLE_GROUPS) {
      const inGroup = buttons.filter((b) => b.icon && group.includes(b.icon))
      expect(inGroup.map((b) => b.title), `confusable icons ${group.join('/')}`).toHaveLength(Math.min(inGroup.length, 1))
    }
  })

  it('gives every destructive control a distinct icon and a tooltip naming the consequence', () => {
    const { container } = render(<NodeChrome {...base} onStop={() => {}} />)
    const buttons = headerButtons(container)
    const destructive = Object.entries(DESTRUCTIVE).map(([title, consequence]) => {
      const b = buttons.find((x) => x.title === title)
      expect(b, title).toBeDefined()
      expect(b!.title).toMatch(consequence)
      return b!
    })
    const icons = destructive.map((b) => b.icon)
    expect(new Set(icons).size).toBe(icons.length)
    for (const d of destructive) expect(buttons.filter((b) => b.icon === d.icon), d.title).toHaveLength(1)
  })

  it('gives every header icon a real tooltip (shadcn), never a native title', () => {
    const { container } = render(<NodeChrome {...base} onStop={() => {}} onToggleMic={() => {}} onAiName={() => {}} />)
    const hosts = [...container.querySelectorAll<HTMLElement>('.node-header vscode-toolbar-button')]
    expect(hosts.length).toBeGreaterThanOrEqual(5)
    for (const host of hosts) {
      const name = host.getAttribute('data-title')
      expect(host.hasAttribute('title'), `${name} has a native title`).toBe(false)
      fireEvent.keyDown(document, { key: 'Tab' }) // keyboard modality: focus opens the tooltip
      fireEvent.focus(host)
      expect(document.querySelector('[role="tooltip"]')?.textContent, name ?? '').toBe(name)
      fireEvent.blur(host)
    }
  })

  it('has no resize-mode button: nodes resize from their edges', () => {
    const { container } = render(<NodeChrome {...base} />)
    expect(container.querySelector('.node-resize-toggle, .codicon-arrow-both')).toBeNull()
  })
})
