// Source scan (node env, no DOM): the UI is ONE bundle for web and native (docs/decisions/header-rail-layout.md,
// "Native and web"). Nothing under src/client or src/shared may branch on the native shell or draw a native-only
// layout, and no stylesheet may declare a window-drag region: the native window keeps its OS title bar, so there
// is nothing to drag. If the owner later picks a frameless window, that change must update this test deliberately.
// Registered in scripts/test.policy.manifest.ts.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHARED_UI_DIRS = ['client', 'shared']
/** Identifiers that would mean "this code knows it runs inside the native shell". */
const NATIVE_BRANCH = /electrobun|isNative|nativeApp|__NATIVE__|window\.native\b/i
const APP_REGION = /-webkit-app-region|app-region/i

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sourcesUnder(p)
    return /\.(ts|tsx|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : []
  })
}

const files = SHARED_UI_DIRS.flatMap((d) => sourcesUnder(path.join(srcRoot, d)))
const rel = (f: string): string => path.relative(srcRoot, f)

describe('one UI for web and native', () => {
  it('scans a meaningful number of files (the walk itself works)', () => {
    expect(files.length).toBeGreaterThan(300)
    expect(files.some((f) => f.endsWith('RailChrome.tsx'))).toBe(true)
  })

  it('no client or shared source branches on the native shell', () => {
    const hits = files.filter((f) => NATIVE_BRANCH.test(readFileSync(f, 'utf8'))).map(rel)
    expect(hits, `native branch in: ${hits.join(', ')}`).toEqual([])
  })

  it('no stylesheet or component declares a window drag region (the native window keeps its OS title bar)', () => {
    const hits = files.filter((f) => APP_REGION.test(readFileSync(f, 'utf8'))).map(rel)
    expect(hits, `app-region in: ${hits.join(', ')}`).toEqual([])
  })

  it('the rail chrome and menu files, specifically, never reference the platform', () => {
    for (const f of ['RailChrome.tsx', 'AppMenuButton.tsx', 'useWorkspaceMenus.ts', 'App.menu.ts', 'Dock.modes.tsx', 'workspaceRail.css', 'headerMode.css']) {
      const text = readFileSync(path.join(srcRoot, 'client', f), 'utf8')
      expect(text, f).not.toMatch(/navigator\.(userAgent|platform)|isMacPlatform|process\.platform/)
    }
  })
})
