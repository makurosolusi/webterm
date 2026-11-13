/** @vitest-environment jsdom */
// Editor status bar: facts come from the live Monaco editor, clicks run Monaco's own actions, the EOL
// switch pushes an undoable EOL edit, viewers show their size, and the setting turns it off.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import EditorStatusBar, { editorFacts, viewerFacts, type EditorLive } from './EditorStatusBar'
import { SettingsProvider } from './useSettings'
import { DEFAULT_SETTINGS } from '../shared/settings'

afterEach(cleanup)

function fakeLive(over: { sels?: { len: number }[]; insertSpaces?: boolean; eol?: string } = {}) {
  const sels = over.sels ?? [{ len: 0 }]
  const sub = () => ({ dispose: () => {} })
  const model = {
    getOptions: () => ({ tabSize: over.insertSpaces === false ? 4 : 2, insertSpaces: over.insertSpaces ?? true }),
    getLanguageId: () => 'yaml',
    getEOL: () => over.eol ?? '\n',
    getValueLengthInRange: (r: { len: number }) => r.len,
    pushEOL: vi.fn(),
  }
  const editor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: 12, column: 5 }),
    getSelections: () => sels,
    focus: vi.fn(),
    trigger: vi.fn(),
    onDidChangeCursorSelection: sub, onDidChangeModelOptions: sub, onDidChangeModelLanguage: sub,
  }
  const monaco = {
    languages: { getLanguages: () => [{ id: 'yaml', aliases: ['YAML', 'yaml'] }] },
    editor: { EndOfLineSequence: { LF: 0, CRLF: 1 } },
  }
  return { live: { editor, monaco } as unknown as NonNullable<EditorLive>, editor, model }
}

describe('editorFacts', () => {
  it('reads position, selection, indentation, EOL and the language name', () => {
    expect(editorFacts(fakeLive({ sels: [{ len: 3 }] }).live)).toEqual({
      position: 'Ln 12, Col 5 (3 selected)', indent: 'Spaces: 2', eol: 'LF', language: 'YAML',
    })
    const tabs = editorFacts(fakeLive({ sels: [{ len: 1 }, { len: 2 }], insertSpaces: false, eol: '\r\n' }).live)
    expect(tabs).toMatchObject({ position: 'Ln 12, Col 5 (2 selections)', indent: 'Tab Size: 4', eol: 'CRLF' })
  })

  it('formats viewer facts as W×H and size', () => {
    expect(viewerFacts({ width: 1920, height: 1080, bytes: 250 * 1024 })).toEqual(['1920×1080', '250 KB'])
    expect(viewerFacts({ bytes: 10 })).toEqual(['10 B'])
    expect(viewerFacts({})).toEqual([])
  })
})

describe('EditorStatusBar', () => {
  it('shows the facts; Ln/Col opens Go to Line in the editor', () => {
    const f = fakeLive()
    render(<EditorStatusBar live={f.live} encoding="utf8" saving={false} readOnly={false} />)
    const bar = screen.getByRole('contentinfo', { name: 'Editor status' })
    expect(bar.textContent).toBe('Ln 12, Col 5Spaces: 2UTF-8LFYAML')
    fireEvent.click(screen.getByRole('button', { name: 'Ln 12, Col 5' }))
    expect(f.editor.focus).toHaveBeenCalled()
    expect(f.editor.trigger).toHaveBeenCalledWith('webterm', 'editor.action.gotoLine', null)
  })

  it('indentation opens a menu of Monaco indentation actions', () => {
    const f = fakeLive()
    render(<EditorStatusBar live={f.live} encoding="utf8" saving={false} readOnly={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Spaces: 2' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Indent Using Tabs' }))
    expect(f.editor.trigger).toHaveBeenCalledWith('webterm', 'editor.action.indentUsingTabs', null)
  })

  it('switches the line ending with an undoable pushEOL, and not while read-only', () => {
    const f = fakeLive()
    const { rerender } = render(<EditorStatusBar live={f.live} encoding="utf8" saving={false} readOnly={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'LF' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'CRLF' }))
    expect(f.model.pushEOL).toHaveBeenCalledWith(1)
    rerender(<EditorStatusBar live={f.live} encoding="non-utf8" saving={false} readOnly />)
    expect(screen.queryByRole('button', { name: 'LF' })).toBeNull()
    expect(screen.getByText('Not UTF-8')).toBeTruthy()
  })

  it('shows "Saving…" while a write is in flight, and viewer facts without an editor', () => {
    const { rerender } = render(<EditorStatusBar live={null} encoding="utf8" saving readOnly={false} />)
    expect(screen.getByRole('contentinfo').textContent).toBe('Saving…')
    rerender(<EditorStatusBar live={null} encoding="utf8" saving={false} readOnly={false} meta={{ width: 64, height: 32, bytes: 2048 }} />)
    expect(screen.getByRole('contentinfo').textContent).toBe('64×322 KB')
    rerender(<EditorStatusBar live={null} encoding="utf8" saving={false} readOnly={false} />)
    expect(screen.queryByRole('contentinfo')).toBeNull()
  })

  it('renders nothing while Settings › Status bar is off', () => {
    render(<SettingsProvider value={{ ...DEFAULT_SETTINGS, nodeStatusBar: false }}><EditorStatusBar live={fakeLive().live} encoding="utf8" saving readOnly={false} /></SettingsProvider>)
    expect(screen.queryByRole('contentinfo')).toBeNull()
  })
})
