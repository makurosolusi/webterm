/**
 * P4b file port: flag, error type, path safety, dan filesystem/git surface for memory files.
 * Pure path helpers plus one injectable port; rendering/parsing and DB rebuild live elsewhere
 * so a single module stays small and each concern testable on its own.
 */
import { flagOn } from '../envFlag'
import { createHash } from 'node:crypto'
import { access, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { requireText } from '../ledger/ledgerCore'
import { gitCommand, gitEnv } from '../gitExec'
import { MemoryError } from './memoryModel'

declare const Bun: {
  spawn(options: { cmd: string[]; cwd: string; env: Record<string, string>
    stdin: 'ignore'; stdout: 'pipe'; stderr: 'pipe' }): { exited: Promise<number>
    stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> }
}

export const MEMORY_FILES_FLAG = 'WEBTERM_MEMORY_FILES'
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_SEGMENT = 96

export function memoryFilesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagOn(env[MEMORY_FILES_FLAG])
}

export class MemoryFileError extends MemoryError {}

export interface MemoryFileExecResult { code: number; stdout: string; stderr: string }
export type MemoryFileSpawn = (file: string, args: string[], cwd: string) => Promise<MemoryFileExecResult>

/** Injectable file + git surface (real impl below; tests inject temp dirs/fakes). */
export interface MemoryFilePort {
  readonly root: string
  /** Creates the root (0700) and initialises a git repo there when missing. Idempotent. */
  ensure?(): Promise<void>
  read(relPath: string): Promise<string | null>
  write(relPath: string, content: string): Promise<void>
  /** Regular files under `relDir`, sorted, posix separators. */
  list(relDir?: string): Promise<string[]>
  /** Runs a program via argv (no shell) and collects its output. */
  exec(file: string, args: string[], cwd: string): Promise<MemoryFileExecResult>
}

export function safeSegment(value: string): string {
  const text = requireText(value, 'memoryFile.segment')
  if (SAFE_SEGMENT.test(text) && !text.includes('..') && text.length <= MAX_SEGMENT) return text
  const slug = text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48)
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 10)
  return `${slug === '' ? 'fact' : slug}-${digest}`
}

/** `<project>/<scope>/<key>.md`: scope is its own segment because the DB key is unique per
 * (project, scope, key) — a flat path would let two facts share one file. */
export function memoryFileRelPath(projectId: string, scope: string, key: string): string {
  return `${safeSegment(projectId)}/${safeSegment(scope)}/${safeSegment(key)}.md`
}

/** Resolves `relPath` under `root`, refusing absolute and `..` escapes. */
export function resolveInside(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.includes('\0') || isAbsolute(relPath)) {
    throw new MemoryFileError(`memory file path must be relative: ${String(relPath)}`)
  }
  const rootPath = resolve(root)
  const full = relPath.trim() === '' ? rootPath : resolve(rootPath, relPath)
  if (full !== rootPath && !full.startsWith(rootPath + sep)) {
    throw new MemoryFileError(`memory file path escapes root: ${relPath}`)
  }
  return full
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** No symlink in the path may escape `root`. */
export async function assertConfined(root: string, relPath: string): Promise<void> {
  const rootReal = await realpathOrNull(resolve(root))
  if (rootReal === null) throw new MemoryFileError(`memory file root does not exist: ${root}`)
  const full = resolveInside(rootReal, relPath)
  const candidates = [full]
  for (let dir = dirname(full); dir !== rootReal && dir.startsWith(rootReal + sep); dir = dirname(dir)) {
    candidates.push(dir)
  }
  for (const candidate of [...candidates, rootReal]) {
    const real = await realpathOrNull(candidate)
    if (real !== null && real !== rootReal && !real.startsWith(rootReal + sep)) {
      throw new MemoryFileError(`memory file path escapes root via symlink: ${relPath}`)
    }
  }
}

function bunSpawn(file: string, args: string[], cwd: string): Promise<MemoryFileExecResult> {
  if (typeof Bun === 'undefined') {
    return Promise.reject(new MemoryFileError('git exec requires Bun.spawn or an injected spawn'))
  }
  // Only git runs here: the gitExec.ts env (no root/bot token, no prompt).
  const proc = Bun.spawn({ cmd: [file, ...args], cwd, env: gitEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    .then(([stdout, stderr, code]) => ({ code, stdout, stderr }))
}

export function createMemoryFilePort(root: string, spawn?: MemoryFileSpawn): MemoryFilePort {
  const rootPath = resolve(root)
  return {
    root: rootPath,
    async ensure() {
      await mkdir(rootPath, { recursive: true, mode: 0o700 })
      // A cold install has no repo: `git add` would fail until one exists.
      if (await pathExists(join(rootPath, '.git'))) return
      const init = gitCommand(['init', '-q'])
      const result = await (spawn ?? bunSpawn)(init.file, init.args, rootPath)
      if (result.code !== 0) {
        throw new MemoryFileError(`git init failed for memory root: ${result.stderr.trim()}`)
      }
    },
    async read(relPath) {
      try {
        return await readFile(resolveInside(rootPath, relPath), 'utf8')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        return code === 'ENOENT' || code === 'EISDIR' ? null : Promise.reject(err)
      }
    },
    async write(relPath, content) {
      const full = resolveInside(rootPath, relPath)
      const dir = dirname(full)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const tmp = join(dir, `.${basename(full)}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`)
      const handle = await open(tmp, 'wx', 0o600)
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
        await handle.chmod(0o600)
      } finally {
        await handle.close()
      }
      try {
        await rename(tmp, full)
      } catch (err) {
        await rm(tmp, { force: true })
        throw err
      }
    },
    async list(relDir = '') {
      const out: string[] = []
      const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.endsWith('.tmp')) continue
          const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
          if (entry.isDirectory()) await walk(join(dir, entry.name), rel)
          else if (entry.isFile()) out.push(rel)
        }
      }
      try {
        await walk(resolveInside(rootPath, relDir), relDir)
      } catch (err) {
        // A cold install (or an empty root) is an empty tree, not a failure.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      return out.sort()
    },
    exec(file, args, cwd) {
      return (spawn ?? bunSpawn)(file, args, cwd)
    },
  }
}
