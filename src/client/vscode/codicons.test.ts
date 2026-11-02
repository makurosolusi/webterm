/** @vitest-environment jsdom */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CODICON_STYLESHEET_ID, installCodicons } from './codicons'

// test-only: worktree ini memakai node_modules symlink di luar root Vite (fs.deny menolak `?url`); di repo biasa tak perlu.
vi.mock('@vscode/codicons/dist/codicon.css?url', () => ({ default: '/codicon.css' }))

// jsdom menulis ulang import.meta.url ke http: resolusi dari cwd (root vitest `src/client` atau root repo).
const themePath = ['vscode/vscode-theme.css', 'src/client/vscode/vscode-theme.css'].map((f) => path.resolve(f)).find((f) => existsSync(f))!
const theme = readFileSync(themePath, 'utf8')
const light = theme.slice(theme.indexOf("[data-theme='light']"))
const dark = theme.slice(0, theme.indexOf("[data-theme='light']"))

describe('installCodicons', () => {
  it('adds one stylesheet link under the id <vscode-icon> looks for, and is idempotent', () => {
    const a = installCodicons(document)
    const b = installCodicons(document)
    expect(a).toBe(b)
    expect(a.id).toBe(CODICON_STYLESHEET_ID)
    expect(a.rel).toBe('stylesheet')
    expect(document.querySelectorAll(`#${CODICON_STYLESHEET_ID}`)).toHaveLength(1)
  })
})

describe('vscode-theme.css palette', () => {
  it('carries the official Dark Modern values', () => {
    for (const tok of [
      '--vscode-editor-background: #1f1f1f',
      '--vscode-sideBar-background: #181818',
      '--vscode-focusBorder: #0078d4',
    ]) expect(dark).toContain(tok)
  })

  it('carries the official Light Modern values', () => {
    for (const tok of [
      '--vscode-editor-background: #ffffff',
      '--vscode-sideBar-background: #f8f8f8',
      '--vscode-focusBorder: #005fb8',
    ]) expect(light).toContain(tok)
  })
})
