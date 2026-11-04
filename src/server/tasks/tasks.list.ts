// Workspace tasks: package.json `scripts` (VS Code NPM Scripts explorer) and the `scripts` map +
// `defaultTabs[].command` of `webterm.yaml` / `orca.yaml` (Orca docs/site/content/docs/model/
// orca-yaml.mdx, "Accepted keys"). `webterm.yaml` wins when both exist, as in
// workspaceWorktree.setup.ts. Package manager by lockfile, like VS Code's `npm.packageManager: auto`.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type TaskSource = 'package.json' | 'webterm.yaml' | 'orca.yaml'

export interface WorkspaceTask {
  /** `<source>:<name>`, stable across listings. */
  id: string
  name: string
  source: TaskSource
  /** What the script does (display only). */
  detail: string
  /** The line typed into the new terminal. */
  run: string
}

export interface TaskFs {
  read(path: string): Promise<string | null>
  exists(path: string): Promise<boolean>
  parseYaml(text: string): unknown
}

/** Same caps as Orca: 256 KiB file, 64 KiB per string field. */
const FILE_MAX = 256 * 1024
const FIELD_MAX = 64 * 1024
const TASKS_MAX = 200

const LOCKFILES: Array<[string, string]> = [['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn']]

export async function packageManager(cwd: string, fs: TaskFs): Promise<string> {
  for (const [file, pm] of LOCKFILES) if (await fs.exists(join(cwd, file))) return pm
  return 'npm'
}

const okString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= FIELD_MAX
/** Script names go on a shell line: only the usual npm-script characters. */
const SAFE_SCRIPT = /^[\w:.@/+-]{1,128}$/

async function packageTasks(cwd: string, fs: TaskFs): Promise<WorkspaceTask[]> {
  const text = await fs.read(join(cwd, 'package.json'))
  if (!text) return []
  let scripts: unknown
  try { scripts = (JSON.parse(text) as { scripts?: unknown }).scripts } catch { return [] }
  if (!scripts || typeof scripts !== 'object') return []
  const pm = await packageManager(cwd, fs)
  return Object.entries(scripts as Record<string, unknown>)
    .filter(([name, cmd]) => SAFE_SCRIPT.test(name) && okString(cmd))
    .map(([name, cmd]) => ({ id: `package.json:${name}`, name, source: 'package.json' as const, detail: cmd as string, run: `${pm} run ${name}` }))
}

async function yamlTasks(cwd: string, fs: TaskFs): Promise<WorkspaceTask[]> {
  for (const source of ['webterm.yaml', 'orca.yaml'] as const) {
    const text = await fs.read(join(cwd, source))
    if (text === null) continue
    let doc: unknown
    try { doc = fs.parseYaml(text) } catch { return [] } // invalid YAML rejects the whole file (Orca)
    if (!doc || typeof doc !== 'object') return []
    const { scripts, defaultTabs } = doc as { scripts?: unknown; defaultTabs?: unknown }
    const out: WorkspaceTask[] = []
    if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
      for (const [name, cmd] of Object.entries(scripts as Record<string, unknown>)) {
        if (okString(cmd)) out.push({ id: `${source}:${name}`, name, source, detail: cmd.trim(), run: cmd.trim() })
      }
    }
    if (Array.isArray(defaultTabs)) {
      for (const tab of defaultTabs.slice(0, 256) as Array<{ title?: unknown; command?: unknown }>) {
        if (!tab || !okString(tab.command)) continue
        const name = okString(tab.title) ? tab.title.trim() : tab.command.trim()
        out.push({ id: `${source}:tab:${name}`, name, source, detail: tab.command.trim(), run: tab.command.trim() })
      }
    }
    return out
  }
  return []
}

export async function listTasks(cwd: string, fs: TaskFs): Promise<WorkspaceTask[]> {
  const [pkg, yaml] = await Promise.all([packageTasks(cwd, fs), yamlTasks(cwd, fs)])
  return [...yaml, ...pkg].slice(0, TASKS_MAX)
}

// Narrow local slice of Bun's API (same as workspaceWorktree.setup.ts).
declare const Bun: { YAML: { parse(text: string): unknown } } | undefined

export const nodeTaskFs: TaskFs = {
  read: async (p) => {
    try {
      const text = await readFile(p, 'utf8')
      return text.length > FILE_MAX ? null : text
    } catch { return null }
  },
  exists: async (p) => readFile(p).then(() => true, () => false),
  parseYaml: (text) => {
    if (typeof Bun === 'undefined') throw new Error('YAML parsing needs the Bun runtime')
    return Bun.YAML.parse(text)
  },
}
