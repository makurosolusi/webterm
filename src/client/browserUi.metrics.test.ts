// Mechanical guard: browser UI must not shrink back below industry minimums (see docs/decisions/browser-ui-standards.md).
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = __dirname
// No exemption list: only tests and fakes are not UI. Tab strip, pane header, separators and state views are scanned like the rest.
const SKIP_FILE = /(\.test\.|\.fake\.)/
const BROWSER_FILE = /^(browser|Browser)/

function collect(dir: string, inBrowserDir: boolean): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (dir === ROOT && !/^(browser|browserTabs|browserSplit|browserDownloads|browserCookies)$/.test(e.name)) continue
      out.push(...collect(p, true))
    } else if (/\.(tsx|css)$/.test(e.name) && !SKIP_FILE.test(e.name) && (inBrowserDir || BROWSER_FILE.test(e.name))) out.push(p)
  }
  return out
}
const FILES = collect(ROOT, false)
const src = (f: string) => readFileSync(f, 'utf8')
const name = (f: string) => relative(ROOT, f)

describe('browser UI metrics', () => {
  it('scans the browser surface', () => {
    const names = FILES.map(name)
    expect(names).toEqual(expect.arrayContaining(['BrowserToolbar.tsx', 'browser.css', 'BrowserConsole.tsx', 'browser/design/DesignModeBar.tsx', 'browserTabs/BrowserTabStrip.tsx', 'browserTabs/browserTabs.css', 'browserSplit/BrowserPaneHeader.tsx', 'browserSplit/browserSplit.css']))
  })

  it('has no font-size below 12px', () => {
    const bad: string[] = []
    for (const f of FILES) {
      src(f).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/(?:font-size:\s*|font:\s*(?:[a-z]+\s+)*|text-\[)(\d+(?:\.\d+)?)px/g)) {
          if (Number(m[1]) < 12) bad.push(`${name(f)}:${i + 1} ${m[0]}`)
        }
      })
    }
    expect(bad).toEqual([])
  })

  it('uses no xs / icon-xs controls (below the 28px hit target)', () => {
    const bad: string[] = []
    for (const f of FILES.filter((x) => x.endsWith('.tsx'))) {
      src(f).split('\n').forEach((line, i) => { if (/size=["'](icon-xs|xs)["']/.test(line)) bad.push(`${name(f)}:${i + 1}`) })
    }
    expect(bad).toEqual([])
  })

  it('defines the --bui tokens once and uses them', () => {
    const ui = src(join(ROOT, 'browserUi.css'))
    for (const [k, v] of Object.entries({ icon: '16px', hit: '28px', font: '13px', 'font-sm': '12px' })) expect(ui).toContain(`--bui-${k}: ${v}`)
    const used = FILES.filter((f) => !f.endsWith('browserUi.css')).map(src).join('\n') + src(join(ROOT, 'components/ui/button.tsx'))
    for (const k of ['icon', 'hit', 'font', 'font-sm', 'omnibox-h', 'gap']) expect(used).toContain(`--bui-${k}`)
    // The tokens are not redefined elsewhere.
    expect(FILES.filter((f) => !f.endsWith('browserUi.css') && /--bui-hit:\s*\d/.test(src(f)))).toEqual([])
  })

  it('sets fonts in the strip, pane header and state views from tokens (no literal px only 14px+ page-level inputs may be literal)', () => {
    const bad: string[] = []
    for (const f of FILES.filter((x) => /browserTabs|browserSplit/.test(x) && x.endsWith('.css'))) {
      src(f).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/(?:font-size:\s*|font:\s*(?:[0-9]{3}\s+)?)(\d+(?:\.\d+)?)px/g)) if (Number(m[1]) < 14) bad.push(`${name(f)}:${i + 1} ${m[0]}`)
      })
    }
    expect(bad).toEqual([])
  })

  it('has no hit target below 24px in the strip and pane header controls (icon buttons use icon-bui)', () => {
    const sizes: string[] = []
    for (const f of FILES.filter((x) => /browserTabs|browserSplit/.test(x) && x.endsWith('.tsx'))) {
      src(f).split('\n').forEach((line, i) => { for (const m of line.matchAll(/size="([a-z-]+)"/g)) if (!['icon-bui', 'bui'].includes(m[1])) sizes.push(`${name(f)}:${i + 1} ${m[0]}`) })
    }
    expect(sizes).toEqual([])
  })
})
