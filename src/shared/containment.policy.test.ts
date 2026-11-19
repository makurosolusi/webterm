// Policy lock: everything stays on the canvas (docs/decisions/canvas-containment.md). webterm's UI runs in the user's own
// browser, so a bare `window.open` / `<a target="_blank">` opens a tab in the machine's Chrome, and the server process
// can reach the machine browser through the OS opener. Every way out of the canvas is listed here with its reason;
// nothing else may appear in `src/` (client, server, shared, native). Do NOT widen the allowlist to make this pass:
// route the feature through src/client/canvasLinks.ts (or the canvas browser node) instead.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

const SRC = join(__dirname, '..')
const posix = (p: string): string => p.split('\\').join('/')

type Exit = 'window.open' | 'target=_blank' | 'location navigation' | 'OS opener' | 'openExternal' | 'createTarget' | 'open package'

/** File (repo-relative, exact) or folder prefix (ends with `/`) that may contain `exit`, with the reason. */
const ALLOW: { path: string; exit: Exit; reason: string }[] = [
  { path: 'src/client/canvasLinks.ts', exit: 'window.open', reason: 'openInSystemBrowser: the one explicit, user-labelled "Open in system browser" exit' },
  { path: 'src/client/chat/chatMessageRow.tsx', exit: 'target=_blank', reason: 'full-size view of an attached image: a data: or same-origin server URL, never an external page' },
  { path: 'src/client/agentChat/agentChatThread.tsx', exit: 'target=_blank', reason: 'full-size view of an attached image: same-origin server URL (data: images get no link)' },
  { path: 'src/server/uiOpen.ts', exit: 'OS opener', reason: 'opens webterm\'s OWN sign-in redirect file (a path, guarded by assertPathArg), the app\'s own window, not a page of another site' },
  { path: 'src/server/workspaceCreate/projectsFolder.ts', exit: 'OS opener', reason: 'reveal a folder in the file manager (`open -R` / xdg-open on a dir; a path, guarded by assertPathArg)' },
  { path: 'src/server/browser/', exit: 'createTarget', reason: 'the canvas browser host owns its own Chromium targets; the runtime guard lives there' },
]

const RULES: { exit: Exit; test: (code: string) => boolean }[] = [
  { exit: 'window.open', test: (c) => /\bwindow\s*\.\s*open\s*\(/.test(c) },
  { exit: 'target=_blank', test: (c) => /target\s*[=:]\s*\{?\s*['"`]_blank['"`]/.test(c) },
  { exit: 'location navigation', test: (c) => /\b(?:window\.)?location\s*\.\s*(?:assign|replace)\s*\(|\b(?:window\.)?location(?:\.href)?\s*=(?!=)/.test(c) },
  // A child-process call naming an OS opener. File-level: the file imports child_process AND names an opener as a call/ternary argument (not `status = 'open'` SQL).
  { exit: 'OS opener', test: (c) => /child_process/.test(c) && /[(\[?:,]\s*['"`](?:open|xdg-open|explorer\.exe|explorer|start|sensible-browser|gnome-open|x-www-browser|wslview)['"`]/.test(c) },
  { exit: 'openExternal', test: (c) => /\bshell\s*\.\s*openExternal|\bopenExternal\s*\(/.test(c) },
  { exit: 'createTarget', test: (c) => /Target\.createTarget|['"`]createTarget['"`]/.test(c) },
  { exit: 'open package', test: (c) => /from\s+['"](?:open|opn|open-cli|xdg-open)['"]|require\(\s*['"](?:open|opn)['"]\s*\)/.test(c) },
]

/** Code only: comments may name an exit (e.g. to explain the rule) without tripping the lock. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')

const isTestOrKit = (name: string): boolean => /\.(?:test|testkit|bun\.test)\.[cm]?[tj]sx?$/.test(name) || /\.testkit\.[tj]sx?$/.test(name) || /\.test-utils\.[tj]sx?$/.test(name)

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.[cm]?[tj]sx?$/.test(name) && !isTestOrKit(name) ? [path] : []
  })
}

const allowed = (file: string, exit: Exit): boolean => ALLOW.some((a) => a.exit === exit && (a.path.endsWith('/') ? file.startsWith(a.path) : a.path === file))

export function violations(file: string, text: string): string[] {
  const body = code(text)
  return RULES.filter((r) => r.test(body) && !allowed(file, r.exit)).map((r) => `${file}: ${r.exit} outside the containment allowlist`)
}

it('the scanner catches each way out of the canvas and ignores comments', () => {
  const bad: [string, string][] = [
    ["window.open(url, '_blank')", 'window.open'],
    ['<a href={u} target="_blank" rel="noreferrer">x</a>', 'target=_blank'],
    ["anchor.setAttribute('x', 1); const o = { target: '_blank' }", 'target=_blank'],
    ['location.assign(url)', 'location navigation'],
    ['window.location.href = url', 'location navigation'],
    ["location = 'https://x.test'", 'location navigation'],
    ["import { spawn } from 'node:child_process'\nspawn('xdg-open', [u])", 'OS opener'],
    ["import { execFile } from 'child_process'\nexecFile(\"explorer.exe\", [u])", 'OS opener'],
    ['shell.openExternal(url)', 'openExternal'],
    ["cdp.send('Target.createTarget', { url })", 'createTarget'],
    ["import open from 'open'", 'open package'],
  ]
  for (const [src, exit] of bad) expect(violations('src/client/x.tsx', src), src).toEqual([`src/client/x.tsx: ${exit} outside the containment allowlist`])
  expect(violations('src/client/x.tsx', '// window.open( is forbidden\n/* target="_blank" */ const a = 1')).toEqual([])
  expect(violations('src/client/x.tsx', 'location.reload(); const b = location.hostname === "x"')).toEqual([])
})

it('allowlist entries are exact, justified, and point at files that still use the exit', () => {
  for (const a of ALLOW) {
    expect(a.reason.length, a.path).toBeGreaterThan(20)
    const files = a.path.endsWith('/') ? sources(join(SRC, '..', a.path)).map((f) => posix(relative(join(SRC, '..'), f))) : [a.path]
    const uses = files.some((f) => RULES.find((r) => r.exit === a.exit)!.test(code(readFileSync(join(SRC, '..', f), 'utf8'))))
    expect(uses, `${a.path} no longer uses ${a.exit}: remove the stale allowlist entry`).toBe(true)
  }
})

it('no source outside the allowlist opens anything outside the canvas', () => {
  const found = sources(SRC).flatMap((f) => violations(posix(join('src', relative(SRC, f))), readFileSync(f, 'utf8')))
  expect(found, 'route links through src/client/canvasLinks.ts; see docs/decisions/canvas-containment.md').toEqual([])
})

it('the allowlisted OS openers still refuse a URL argument', () => {
  for (const f of ['src/server/uiOpen.ts', 'src/server/workspaceCreate/projectsFolder.ts']) {
    expect(code(readFileSync(join(SRC, '..', f), 'utf8')), f).toContain('assertPathArg(')
  }
})
