// Policy lock: an act frame (store, chips, tray) never moves the camera. Only a user gesture or the Follow
// controller (centralFollow.ts, via revealNode) may, and only the files named here may call a camera method.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

const CLIENT = __dirname
/** Files allowed to call a camera method, each a user-initiated or lifecycle move that predates the act signal. */
const CAMERA_ALLOWLIST: Readonly<Record<string, string>> = {
  'nodeReveal.ts': 'revealNode: Show / open-file / Follow, when the node is off screen or too small to read',
  'canvasViewport.ts': 'zoom / fit buttons and view history',
  'workspaceLifecycle.ts': 'board boot and switch; onFocus for the user\'s own click',
  'App.canvas.tsx': 'mini-map click',
  // Pre-existing, user-triggered:
  'App.tsx': 'fit-view shortcut wiring',
  'commandRegistry.defaults.ts': 'command palette: Fit view',
  'layersPanel.tsx': 'click a row in Layers',
  'canvasMenu.pane.tsx': 'pane context menu: Fit',
  'canvasMenu.model.ts': 'pane context menu model',
}
const CAMERA = /\b(?:setCenter|fitView|setViewport|fitBounds)\s*\(/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.(?:tsx?|js)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/TestKit\.tsx?$/.test(name) ? [path] : []
  })
}
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

it('the scanner flags a camera call and ignores comments', () => {
  expect(CAMERA.test(code('rf.setCenter(1, 2)'))).toBe(true)
  expect(CAMERA.test(code('void rf.fitView({ nodes })'))).toBe(true)
  expect(CAMERA.test(code('// rf.setCenter(1, 2)'))).toBe(false)
})

it('only named files call a camera method (and none of the Central act files does)', () => {
  const files = sources(CLIENT)
  expect(files.length).toBeGreaterThan(100)
  const callers = files.filter((p) => CAMERA.test(code(readFileSync(p, 'utf8')))).map((p) => relative(CLIENT, p))
  const strays = callers.filter((p) => !(p.split('/').pop()! in CAMERA_ALLOWLIST))
  expect(strays).toEqual([])
  expect(callers.filter((p) => /centralAct|CentralAct/.test(p))).toEqual([])
})

it('Follow moves the camera only through revealNode, and only the controller does', () => {
  const follow = readFileSync(join(CLIENT, 'centralFollow.ts'), 'utf8')
  expect(CAMERA.test(code(follow))).toBe(false)
  expect(code(follow)).toMatch(/revealNode\([\s\S]*?focus:\s*false/)
  const users = sources(CLIENT).filter((p) => /zoomToReadable:\s*true/.test(code(readFileSync(p, 'utf8')))).map((p) => relative(CLIENT, p)).sort()
  // Follow (automatic) and the layer's Show click (user gesture) are the only zoom-to-readable callers.
  expect(users).toEqual(['centralAct.layer.tsx', 'centralFollow.ts'])
  const store = readFileSync(join(CLIENT, 'centralAct.store.ts'), 'utf8')
  expect(code(store)).not.toMatch(/revealNode|centralFollow/)
})

it('the act styles keep a static branch under prefers-reduced-motion', () => {
  const css = readFileSync(join(CLIENT, 'centralAct.css'), 'utf8')
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
  expect(reduced).toMatch(/\.nt-touched\s*\{[^}]*animation:\s*none/)
  expect(reduced).toMatch(/\.nt-cable-active[^{]*\{[^}]*animation:\s*none/)
  // The static node mark still has an outline (information is not dropped with the motion).
  expect(reduced).toMatch(/outline-width:\s*2px/)
})

it('the live region is never assertive', () => {
  const tray = readFileSync(join(CLIENT, 'CentralActTray.tsx'), 'utf8')
  expect(code(tray)).not.toMatch(/assertive|role="alert"/)
})
