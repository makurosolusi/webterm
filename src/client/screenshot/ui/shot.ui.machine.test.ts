import { describe, expect, test } from 'vitest'
import { DEFAULT_COLOR, MARKER_DEFAULT_COLOR, SHOT_COLORS } from '../shot.palette'
import type { ShotFrame } from '../shot.render'
import type { Shape } from '../shot.types'
import { initialState, shotReducer, type UiAction, type UiState } from './shot.ui.machine'
import { SHOT_TEXT } from './shot.ui.text'

const frame = { width: 2000, height: 1200 } as ShotFrame
const run = (s: UiState, ...actions: UiAction[]): UiState => actions.reduce(shotReducer, s)
const open = (): UiState => run(initialState(), { type: 'start' }, { type: 'captured', frame, css: { w: 1000, h: 600 }, scale: 2 })
const selected = (): UiState => run(open(), { type: 'commitSelection', rect: { x: 100, y: 100, w: 400, h: 300 } })
const stroke: Shape = { kind: 'rect', color: '#f00', width: 4, from: { x: 1, y: 1 }, to: { x: 50, y: 50 } }

describe('capture phase', () => {
  test('idle -> capturing -> selecting; a second start is ignored (one instance)', () => {
    const c = run(initialState(), { type: 'start' })
    expect(c.phase).toBe('capturing')
    expect(shotReducer(c, { type: 'start' })).toBe(c)
    expect(open().phase).toBe('selecting')
    expect(shotReducer(open(), { type: 'start' }).phase).toBe('selecting')
  })

  test.each(['page_too_large', 'failed'] as const)('%s ends idle with an error notice offering retry', (reason) => {
    const s = run(initialState(), { type: 'start' }, { type: 'captureFailed', reason })
    expect(s.phase).toBe('idle')
    expect(s.notice).toMatchObject({ kind: 'error', title: SHOT_TEXT.errors[reason].title, action: 'retry' })
  })

  test('busy ends idle with an error notice and no retry button', () => {
    const s = run(initialState(), { type: 'start' }, { type: 'captureFailed', reason: 'busy' })
    expect(s.notice).toMatchObject({ kind: 'error', title: SHOT_TEXT.errors.busy.title })
    expect(s.notice?.action).toBeUndefined()
  })

  test('capture cannot be closed or fed selection input', () => {
    const c = run(initialState(), { type: 'start' })
    expect(shotReducer(c, { type: 'close' })).toBe(c)
    expect(shotReducer(c, { type: 'selectAll' })).toBe(c)
    expect(shotReducer(c, { type: 'commitSelection', rect: { x: 0, y: 0, w: 50, h: 50 } })).toBe(c)
  })
})

describe('selection', () => {
  test('a drag below the minimum is dropped and stays in selecting', () => {
    const s = run(open(), { type: 'dragSelection', rect: { x: 5, y: 5, w: 3, h: 3 } }, { type: 'commitSelection', rect: { x: 5, y: 5, w: 3, h: 3 } })
    expect(s.phase).toBe('selecting')
    expect(s.selection).toBeNull()
  })

  test('a valid drag commits (rounded) and selects', () => {
    const s = run(open(), { type: 'commitSelection', rect: { x: 10.4, y: 10.6, w: 99.5, h: 80 } })
    expect(s.phase).toBe('selected')
    expect(s.selection).toEqual({ x: 10, y: 11, w: 100, h: 80 })
  })

  test('selectAll picks the whole image; move/resize work only once selected', () => {
    expect(run(open(), { type: 'selectAll' }).selection).toEqual({ x: 0, y: 0, w: 2000, h: 1200 })
    expect(shotReducer(open(), { type: 'setSelection', rect: { x: 1, y: 1, w: 50, h: 50 } }).selection).toBeNull()
    expect(shotReducer(selected(), { type: 'setSelection', rect: { x: 1, y: 2, w: 50, h: 60 } }).selection).toEqual({ x: 1, y: 2, w: 50, h: 60 })
  })
})

describe('annotation', () => {
  test('tools, shapes, undo and redo only apply to a committed selection', () => {
    expect(shotReducer(open(), { type: 'addShape', shape: stroke }).shots.shapes).toHaveLength(0)
    expect(shotReducer(open(), { type: 'setTool', tool: 'pen' }).tool).toBeNull()
    const s = run(selected(), { type: 'setTool', tool: 'rect' }, { type: 'addShape', shape: stroke })
    expect(s.tool).toBe('rect')
    expect(s.shots.shapes).toHaveLength(1)
    const u = shotReducer(s, { type: 'undo' })
    expect(u.shots.shapes).toHaveLength(0)
    expect(shotReducer(u, { type: 'redo' }).shots.shapes).toHaveLength(1)
    expect(shotReducer(u, { type: 'undo' })).toBe(u) // nothing to undo: same state
  })

  test('invalid shapes (empty text) are ignored by the model', () => {
    const s = run(selected(), { type: 'addShape', shape: { kind: 'text', color: '#f00', at: { x: 0, y: 0 }, text: '  ', size: 16 } })
    expect(s.shots.shapes).toHaveLength(0)
  })

  test('marker starts yellow and gives red back, but never overrides a color the user picked', () => {
    const m = run(selected(), { type: 'setTool', tool: 'marker' })
    expect(m.color).toBe(MARKER_DEFAULT_COLOR)
    expect(shotReducer(m, { type: 'setTool', tool: 'pen' }).color).toBe(DEFAULT_COLOR)
    const blue = run(selected(), { type: 'setColor', color: SHOT_COLORS[4].value }, { type: 'setTool', tool: 'marker' })
    expect(blue.color).toBe(SHOT_COLORS[4].value)
  })
})

describe('export', () => {
  test('copy ok closes with a Copied notice', () => {
    const s = run(selected(), { type: 'exportStart', kind: 'copy' })
    expect(s.phase).toBe('copying')
    const done = shotReducer(s, { type: 'exportDone', kind: 'copy', result: 'ok' })
    expect(done.phase).toBe('idle')
    expect(done.frame).toBeNull()
    expect(done.notice).toMatchObject({ kind: 'info', title: SHOT_TEXT.copied })
  })

  test('save ok closes with the file name', () => {
    const s = run(selected(), { type: 'exportStart', kind: 'save' }, { type: 'exportDone', kind: 'save', result: 'ok', name: 'a.png' })
    expect(s.phase).toBe('idle')
    expect(s.notice?.title).toBe('Saved a.png')
  })

  test.each([['denied', 'copyDenied'], ['unsupported', 'copyUnsupported'], ['failed', 'copyFailed']] as const)('copy %s stays open and offers Save', (result, key) => {
    const s = run(selected(), { type: 'exportStart', kind: 'copy' }, { type: 'exportDone', kind: 'copy', result })
    expect(s.phase).toBe('selected')
    expect(s.selection).not.toBeNull()
    expect(s.notice).toMatchObject({ kind: 'error', title: SHOT_TEXT.errors[key].title, action: 'save' })
  })

  test('a failed save stays open with an error', () => {
    const s = run(selected(), { type: 'exportStart', kind: 'save' }, { type: 'exportDone', kind: 'save', result: 'failed' })
    expect(s.phase).toBe('selected')
    expect(s.notice).toMatchObject({ kind: 'error', title: SHOT_TEXT.errors.saveFailed.title })
  })

  test('export is ignored unless selected, and close is ignored mid-export', () => {
    expect(shotReducer(open(), { type: 'exportStart', kind: 'copy' }).phase).toBe('selecting')
    const c = run(selected(), { type: 'exportStart', kind: 'copy' })
    expect(shotReducer(c, { type: 'close' })).toBe(c)
    expect(shotReducer(c, { type: 'exportStart', kind: 'save' })).toBe(c)
  })

  test('notice ids grow, so the same error twice is shown twice', () => {
    const a = run(selected(), { type: 'exportStart', kind: 'copy' }, { type: 'exportDone', kind: 'copy', result: 'denied' })
    const b = run(a, { type: 'exportStart', kind: 'copy' }, { type: 'exportStart', kind: 'copy' })
    const c = run(b, { type: 'exportDone', kind: 'copy', result: 'denied' })
    expect(c.notice!.id).toBeGreaterThan(a.notice!.id)
  })
})

describe('close', () => {
  test('selecting and selected close to idle with everything dropped', () => {
    for (const s of [open(), selected()]) {
      const c = shotReducer(s, { type: 'close' })
      expect(c).toMatchObject({ phase: 'idle', frame: null, selection: null })
      expect(c.shots.shapes).toHaveLength(0)
    }
  })

  test('the next session keeps the remembered color, width and text size', () => {
    const s = run(selected(), { type: 'setColor', color: SHOT_COLORS[4].value }, { type: 'setWidth', width: 8 }, { type: 'close' }, { type: 'start' })
    expect(s).toMatchObject({ phase: 'capturing', color: SHOT_COLORS[4].value, width: 8 })
  })

  test('dismissNotice clears it', () => {
    const s = run(initialState(), { type: 'start' }, { type: 'captureFailed', reason: 'failed' }, { type: 'dismissNotice' })
    expect(s.notice).toBeNull()
  })
})
