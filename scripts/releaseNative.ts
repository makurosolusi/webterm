// `npm run release:native`: build the stable native app and gather the update files Electrobun wrote to
// artifacts/ into release/native/<version>/, ready to upload flat to UPDATE_BASE_URL. It never uploads and never
// bumps the version: a version that already has a folder is refused (bump package.json first), so a published
// release is never overwritten.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import pkg from '../package.json'
import { UPDATE_BASE_URL } from '../src/native/release.config'

/** Update files of a stable build (Electrobun's flat `stable-<os>-<arch>-` naming): manifests, bundle, delta patches. */
const UPDATE_FILE = /^stable-.+(?:\.json|\.tar\.zst|\.patch)$/

/** release/native/<version> under `root`. */
export const releaseDir = (root: string, version: string): string => join(root, 'release', 'native', version)

/** Throws when `version` already has a release folder: the user must bump package.json first. */
export function assertNewRelease(root: string, version: string): void {
  const dir = releaseDir(root, version)
  if (existsSync(dir)) throw new Error(`release ${version} already exists at ${dir}: bump "version" in package.json first (this script never bumps it)`)
}

/** Copy the update files written to `artifactsDir` at or after `sinceMs` (this build, not leftovers) into `dest`.
 *  Returns the copied names; throws when the build left no update manifest. */
export function collectArtifacts(artifactsDir: string, dest: string, sinceMs: number): string[] {
  const names = readdirSync(artifactsDir)
    .filter((n) => UPDATE_FILE.test(n) && statSync(join(artifactsDir, n)).mtimeMs >= sinceMs)
    .sort()
  if (!names.some((n) => n.endsWith('.json'))) throw new Error(`no update manifest (stable-*-update*.json) from this build in ${artifactsDir}`)
  mkdirSync(dest, { recursive: true })
  for (const n of names) copyFileSync(join(artifactsDir, n), join(dest, n))
  return names
}

function main(): void {
  const root = join(import.meta.dirname, '..')
  const { version } = pkg
  assertNewRelease(root, version)
  if (UPDATE_BASE_URL === '') console.warn('warning: UPDATE_BASE_URL (src/native/release.config.ts) is empty: this build will never check for updates, and no patch is generated')
  // Filesystem mtimes can round down; one second of slack keeps this build's files in.
  const startedMs = Date.now() - 1_000
  const build = spawnSync('bun', ['run', 'build:native'], { cwd: root, stdio: 'inherit' })
  if (build.error) throw new Error(`cannot run build:native: ${build.error.message}`)
  if (build.status !== 0) throw new Error(`build:native failed with exit code ${build.status}`)
  const dest = releaseDir(root, version)
  const names = collectArtifacts(join(root, 'artifacts'), dest, startedMs)
  console.log(`\nwebterm ${version}: ${names.length} file(s) in ${dest}`)
  for (const n of names) console.log(`  ${n}`)
  console.log(`\nUpload these files flat (no subfolder, names unchanged) to ${UPDATE_BASE_URL || '<UPDATE_BASE_URL, not set yet>'}/`)
  console.log('Upload the .tar.zst and .patch files before the update*.json manifests, so no app sees a manifest whose bundle is missing.')
}

if (import.meta.main) {
  try {
    main()
  } catch (err) {
    console.error(`release:native: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
