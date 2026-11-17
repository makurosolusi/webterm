// Policy lock: Central's camera limits are the canvas's own (App.canvas.tsx), so a tool can never ask for a view
// the human could not reach, and moving either side without the other fails here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, clampTo } from '../shared/canvasCamera'

it('the shared zoom range equals the React Flow canvas minZoom / maxZoom', () => {
  const src = readFileSync(join(__dirname, 'App.canvas.tsx'), 'utf8')
  expect(Number(/minZoom=\{([\d.]+)\}/.exec(src)?.[1])).toBe(CAMERA_MIN_ZOOM)
  expect(Number(/maxZoom=\{([\d.]+)\}/.exec(src)?.[1])).toBe(CAMERA_MAX_ZOOM)
})

it('clampTo bounds a value and sends NaN to the minimum', () => {
  expect([clampTo(5, 0, 2), clampTo(-5, 0, 2), clampTo(1, 0, 2), clampTo(Number.NaN, 0.5, 2), clampTo(Infinity, 0, 2)]).toEqual([2, 0, 1, 0.5, 2])
})
