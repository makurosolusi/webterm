// Policy lock 6 (Phase B, sec-236): the UI's only credential is the HttpOnly `wt_ui` cookie, which
// same-origin fetch / WebSocket / EventSource send by themselves. No client source may put a token
// in a URL (`token=`) or a header, or keep one in web storage, where page script, logs, the address
// bar and Referer can read it. The single `?token=` landing link lives in the allowlisted files.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

const CLIENT = __dirname
/** Strips the legacy landing link (and trades it while no account exists); nothing else may. */
const TOKEN_PARAM_OWNERS = ['transportToken.ts']
const FORBIDDEN: [string, RegExp][] = [
  ['the removed token transport helpers', /\b(?:tokenQuery|peekToken|withToken|TOKEN_HEADER|TOKEN_KEY)\b/],
  ['a token header', /x-webterm-token/i],
  ['a token query parameter', /[?&]token=|['"`]token=/],
  ['a token kept in web storage', /webterm\.token/],
]

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.(?:tsx?|js)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

/** Code only: comments may explain the old `?token=` scheme without tripping the lock. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function violations(file: string, text: string): string[] {
  const body = code(text)
  const found = FORBIDDEN.filter(([, re]) => re.test(body)).map(([what]) => `${file}: ${what}`)
  if (/\bTOKEN_PARAM\b/.test(body) && !TOKEN_PARAM_OWNERS.includes(file)) found.push(`${file}: TOKEN_PARAM outside the landing-link owners`)
  return found
}

it('the scanner catches each forbidden shape and ignores comments', () => {
  expect(violations('a.ts', "fetch(`/api/x?${tokenQuery()}`)")).toHaveLength(1)
  expect(violations('a.ts', "headers: { 'x-webterm-token': t }")).toHaveLength(1)
  expect(violations('a.ts', 'new WebSocket(`${base}/ws?token=${t}`)')).toHaveLength(1)
  expect(violations('a.ts', "const q = 'token=' + t")).toHaveLength(1)
  expect(violations('a.ts', "sessionStorage.setItem('webterm.token', t)")).toHaveLength(1)
  expect(violations('a.ts', "import { TOKEN_PARAM } from './transportToken'")).toHaveLength(1)
  expect(violations('transportToken.ts', "url.searchParams.get(TOKEN_PARAM)")).toEqual([])
  expect(violations('a.ts', '// the old `?token=` link\n/* tokenQuery() */\nconst u = `${proto}://${host}/ws`')).toEqual([])
})

it('no client source attaches a token to a request', () => {
  const files = sources(CLIENT)
  expect(files.length).toBeGreaterThan(100) // the walk really saw the client tree
  const found = files.flatMap((path) => violations(relative(CLIENT, path), readFileSync(path, 'utf8')))
  expect(found).toEqual([])
})
