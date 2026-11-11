// `webterm --reset-password <username>`: operator recovery without the server. Synchronous end to end
// (cliGate.ts must exit before index.ts evaluates its next import), so it uses
// UserStore.resetPasswordSync. The new password comes from the terminal with echo off (asked twice) or,
// when stdin is not a terminal, from its first line. Nothing secret is ever printed.
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, readSync } from 'node:fs'
import { childEnv } from '../childEnv'
import { dbPath } from '../config'
import type * as UiSession from '../uiSession'
import type * as UiUser from '../uiUser'

export const EXIT_RESET_OK = 0
export const EXIT_RESET_FAILED = 1
export const EXIT_RESET_USAGE = 2
const STDIN = 0
const CHUNK = 256

export interface ResetIo { writeErr(text: string): void; writeOut(text: string): void }

/** One line from stdin, read synchronously byte chunks at a time; null at EOF with nothing read. */
function readLineSync(): string | null {
  const buf = Buffer.alloc(CHUNK)
  const parts: Buffer[] = []
  for (;;) {
    let n: number
    try {
      n = readSync(STDIN, buf, 0, CHUNK, null)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue // non-blocking TTY: no input yet
      throw new Error(`reading the password from stdin failed: ${(e as Error).message}`, { cause: e })
    }
    if (n === 0) break
    const chunk = buf.subarray(0, n)
    const nl = chunk.indexOf(0x0a)
    parts.push(Buffer.from(nl >= 0 ? chunk.subarray(0, nl) : chunk))
    if (nl >= 0) break
  }
  if (parts.length === 0) return null
  return Buffer.concat(parts).toString('utf8').replace(/\r$/, '')
}

/** stty on the controlling terminal (stdin inherited); false when stty is unavailable. */
const stty = (arg: string): boolean => spawnSync('stty', [arg], { stdio: ['inherit', 'ignore', 'ignore'], env: childEnv() }).status === 0

/** Prompt with echo off; echo is restored even when reading throws. */
function askHidden(io: ResetIo, prompt: string): string | null {
  io.writeErr(prompt)
  const hidden = stty('-echo')
  try {
    return readLineSync()
  } finally {
    if (hidden) stty('echo')
    io.writeErr('\n')
  }
}

/** The new password, or an error message for the operator. */
function readNewPassword(io: ResetIo, isTty: boolean): { password: string } | { error: string } {
  if (!isTty) {
    const line = readLineSync()
    return line ? { password: line } : { error: 'no password on stdin' }
  }
  const first = askHidden(io, 'New password: ')
  if (!first) return { error: 'no password entered' }
  if (askHidden(io, 'Repeat new password: ') !== first) return { error: 'passwords do not match' }
  return { password: first }
}

/** Reset `username`'s password in `<data dir>/webterm.db` and revoke its sessions; returns the exit code. */
export function runResetPassword(username: string, io: ResetIo, isTty: boolean = process.stdin.isTTY === true): number {
  const file = dbPath()
  if (!existsSync(file)) {
    io.writeErr('webterm: no account database in the data dir (set WEBTERM_DATA_DIR?)\n')
    return EXIT_RESET_FAILED
  }
  // Loaded after the check: importing db.ts (via these stores) creates webterm.db as a side effect,
  // and a typo'd data dir must not gain an empty database.
  const { createUiSessionStore } = require('../uiSession') as typeof UiSession
  const { AuthError, createUserStore } = require('../uiUser') as typeof UiUser
  const db = new Database(file)
  try {
    const users = createUserStore(db)
    // Check first so a typo does not cost two password prompts (the store re-checks anyway).
    if (!db.query('SELECT 1 FROM ui_user WHERE username = ?').get(username)) {
      io.writeErr('webterm: no such account\n')
      return EXIT_RESET_FAILED
    }
    const got = readNewPassword(io, isTty)
    if ('error' in got) {
      io.writeErr(`webterm: ${got.error}\n`)
      return EXIT_RESET_USAGE
    }
    const user = users.resetPasswordSync(username, got.password)
    createUiSessionStore(db).revokeUser(user.id)
    io.writeOut('Password reset; every session of that account is signed out.\n')
    return EXIT_RESET_OK
  } catch (e) {
    if (!(e instanceof AuthError)) throw new Error(`password reset failed: ${(e as Error).message}`, { cause: e })
    io.writeErr(`webterm: ${e.code === 'not_found' ? 'no such account' : e.message}\n`)
    return e.code === 'not_found' ? EXIT_RESET_FAILED : EXIT_RESET_USAGE
  } finally {
    db.close()
  }
}
