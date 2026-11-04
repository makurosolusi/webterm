// What each caller last saw of the registry, for `webterm whats-new`. Two small files under
// `<dataDir>/cli/`: one snapshot per registry version ever served (the registry is compiled in, so the
// only way to diff against an older server is to have kept its snapshot), and principal -> version.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RegistrySnapshot } from './cli.registry'

const VERSION_RE = /^[0-9a-f]{12}$/

export interface SeenStore {
  snapshot(version: string): RegistrySnapshot | null
  saveSnapshot(snap: RegistrySnapshot): void
  lastSeen(principal: string): string | null
  markSeen(principal: string, version: string): void
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, file)
}

/** File-backed store rooted at `dir` (created on first write). */
export function createSeenStore(dir: string): SeenStore {
  const seenFile = join(dir, 'seen.json')
  const snapDir = join(dir, 'registry')
  const readSeen = (): Record<string, string> => {
    try {
      const v = JSON.parse(readFileSync(seenFile, 'utf8')) as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
    } catch {
      return {} // absent or torn file = never seen; whats-new then reports the whole registry
    }
  }
  return {
    snapshot(version) {
      if (!VERSION_RE.test(version)) return null
      try {
        return JSON.parse(readFileSync(join(snapDir, `${version}.json`), 'utf8')) as RegistrySnapshot
      } catch {
        return null // unknown version: the caller reports it as an unknown baseline
      }
    },
    saveSnapshot(snap) {
      const file = join(snapDir, `${snap.version}.json`)
      if (existsSync(file)) return
      mkdirSync(snapDir, { recursive: true, mode: 0o700 })
      writeAtomic(file, JSON.stringify(snap))
    },
    lastSeen(principal) {
      const v = readSeen()[principal]
      return typeof v === 'string' && VERSION_RE.test(v) ? v : null
    },
    markSeen(principal, version) {
      const all = readSeen()
      if (all[principal] === version) return
      all[principal] = version
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeAtomic(seenFile, JSON.stringify(all))
    },
  }
}
