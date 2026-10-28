import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export function dataDir(): string {
  const dir = process.env.WEBTERM_DATA_DIR || join(homedir(), '.webterm-server')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function dbPath(): string {
  return join(dataDir(), 'webterm.db')
}
