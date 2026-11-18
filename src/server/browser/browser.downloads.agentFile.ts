// How an agent gets at a downloaded file: the server reads or copies it on the agent's behalf, after the caller has proven
// (cable -> browser node -> profile folder) that the file is its own. The agent sandbox cannot read `<dataDir>/downloads`
// (docs/decisions/browser-downloads.md), so this is the only way, and every refusal here is a concrete `AgentTabError`.
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { DOWNLOAD_COPY_TO_MAX_CHARS, DOWNLOAD_READ_MAX_BYTES } from '../../shared/browser.contract.downloads'
import { isInside } from '../transcriptPath'
import { AgentTabError } from './browser.agentTabs.verbs'

const refuse = (wire: string, status: number, message: string, next: string): AgentTabError => new AgentTabError(wire, status, message, next)

/** A browser-issued download guid; anything else never reaches the file system. */
export const DOWNLOAD_ID = /^[A-Za-z0-9-]{1,64}$/

/** First `DOWNLOAD_READ_MAX_BYTES` of a finished file as text; a binary file (a NUL byte) is refused with the way to take it. */
export function readDownloadText(path: string): { text: string; bytes: number; truncated: boolean } {
  let fd: number | undefined
  try {
    if (!lstatSync(path).isFile()) throw refuse('download_missing', 404, 'The downloaded file is gone from disk.', 'List the downloads again.')
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const bytes = fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(bytes, DOWNLOAD_READ_MAX_BYTES))
    const got = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, got)
    if (head.includes(0)) throw refuse('download_binary', 415, 'This file is binary; it cannot be read as text.', 'Take it into your working directory with `webterm browser downloads copy <id> <name>`.')
    return { text: head.toString('utf8'), bytes, truncated: bytes > got }
  } catch (err) {
    if (err instanceof AgentTabError) throw err
    throw refuse('download_unreadable', 500, `The downloaded file could not be read (${(err as NodeJS.ErrnoException).code ?? 'io error'}).`, 'List the downloads again; tell the user if it persists.')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The destination as a clean relative path, or why not: relative, inside the working directory, no hidden (dot) names so a
 * download can never land in `.git/hooks`, `.claude` or `.env*` (the sandbox protects those from the agent, not from us).
 */
export function copyTarget(to: unknown): string {
  const bad = (why: string): never => { throw refuse('bad_destination', 400, `Destination refused: ${why}.`, 'Pass a plain relative file name such as `report.pdf` or `data/report.pdf` (the folder must exist).') }
  if (typeof to !== 'string' || to.trim() === '') return bad('a file name is required')
  if (to.length > DOWNLOAD_COPY_TO_MAX_CHARS || to.includes('\0')) return bad('too long or not text')
  if (isAbsolute(to)) return bad('it must be relative to your working directory')
  const clean = normalize(to)
  const parts = clean.split(sep)
  if (parts.includes('..')) return bad('it must stay inside your working directory')
  if (parts.some((p) => p.startsWith('.'))) return bad('hidden (dot) names are not allowed')
  if (to.endsWith('/') || basename(clean) === '' || clean === '.') return bad('it must name a file, not a folder')
  return clean
}

/** Copy `src` to `to` under the agent's `cwd`: the folder must exist inside it (symlinks resolved), the file must not. Returns the relative path. */
export function copyDownloadInto(src: string, cwd: string, to: string): string {
  let root: string
  try { root = realpathSync(cwd) } catch { throw refuse('no_agent_cwd', 400, 'Your working directory is not available.', 'Use `webterm browser downloads read <id>` instead.') }
  let dir: string
  try { dir = realpathSync(resolve(root, dirname(to))) } catch { throw refuse('bad_destination', 400, 'Destination refused: the folder does not exist.', 'Create the folder first or use a file name in the working directory.') }
  if (!isInside(root, dir)) throw refuse('bad_destination', 400, 'Destination refused: it resolves outside your working directory.', 'Use a folder that really lives in your working directory.')
  const dest = join(dir, basename(to))
  try {
    copyFileSync(src, dest, constants.COPYFILE_EXCL)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw refuse('destination_exists', 409, 'Destination refused: a file with that name already exists.', 'Pick another name; nothing was overwritten.')
    throw refuse('copy_failed', 500, `The file could not be copied (${code ?? 'io error'}).`, 'Tell the user if it persists.')
  }
  return relative(root, dest)
}
