// Policy lock: text and its Enter in ONE PTY write is read by Claude Code as a paste, so the prompt sits
// unsent in the input box. Every server submit goes through `agentSubmit.ts` (`submitToNode`), the
// only file allowed to glue `\r` onto text (its plain-shell branch).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

const SERVER = __dirname
const ALLOWED = ['agentSubmit.ts']
/** `${text}\r` in a template, or `text + '\r'` / `+ "\r"`. */
const GLUED_ENTER = [/\$\{[^}]*\}\\r`/, /\+\s*(['"`])\\r\1/]

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test(util)?\.tsx?$|\.testutil\.tsx?$/.test(name) ? [path] : []
  })
}

it('the scanner sees a glued Enter and accepts a separate one', () => {
  const glued = (line: string): boolean => GLUED_ENTER.some((re) => re.test(line))
  expect(glued('sessions.input(id, `${text}\\r`)')).toBe(true)
  expect(glued("sessions.input(id, text + '\\r')")).toBe(true)
  expect(glued("sessions.input(id, '\\r')")).toBe(false)
})

it('no server file but agentSubmit.ts writes text and Enter in one go', () => {
  const offenders = sources(SERVER)
    .filter((file) => !ALLOWED.includes(relative(SERVER, file)))
    .flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
      GLUED_ENTER.some((re) => re.test(line)) ? [`${relative(SERVER, file)}:${i + 1}`] : []))
  expect(offenders, 'submit through submitToNode (src/server/agentSubmit.ts) instead').toEqual([])
})
