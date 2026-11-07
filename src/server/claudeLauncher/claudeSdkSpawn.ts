// Starts the Claude Agent SDK's CLI child through a webterm launch profile (e.g. `envman -e p -- claude`).
// Shared by Agent Chat and Central. The SDK's own args are appended to the profile argv; `o.command`
// (the bundled binary) is ignored. With `spawnClaudeCodeProcess` set the SDK never reads the child's
// stderr (sdk.mjs 0.3.318 reads it only in its own local spawn; probed with a fake child), so the hook
// drains it here: the caller gets every chunk and a chatty child never blocks on a full pipe.
import { spawn as nodeSpawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { Options, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'

/** Fallback executable name when a profile has no claude token. */
const DEFAULT_CLAUDE_BIN = 'claude'

export type SpawnImpl = (command: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; stdio: 'pipe'; signal: AbortSignal }) => SpawnedProcess

export interface ClaudeSdkSpawnInput {
  /** Launch profile argv (wrapper + claude + profile flags) and its claude token. */
  launch: { argv: readonly string[]; bin: string }
  /** Process spawner; tests inject a recorder. Defaults to node's spawn (a ChildProcess satisfies SpawnedProcess). */
  spawn?: SpawnImpl
  /** Child stderr chunks (may hold prompts or output: keep a bounded tail, never log raw). */
  stderr?: (chunk: string) => void
  /** Sees the child right after spawn (exit status, spawn errno). */
  onChild?: (child: SpawnedProcess) => void
}

/** The SDK options that run Claude through the profile instead of the SDK's bundled binary. */
export function claudeSdkSpawn(i: ClaudeSdkSpawnInput): Required<Pick<Options, 'pathToClaudeCodeExecutable' | 'spawnClaudeCodeProcess'>> {
  const spawnImpl = i.spawn ?? (nodeSpawn as unknown as SpawnImpl)
  const [cmd, ...lead] = i.launch.argv
  return {
    // Required next to the hook: the SDK resolves its bundled binary before calling the hook.
    pathToClaudeCodeExecutable: i.launch.bin || DEFAULT_CLAUDE_BIN,
    // `o.env` only: the SDK already applied `options.env`; merging process.env back would reintroduce CLAUDECODE.
    spawnClaudeCodeProcess: (o: SpawnOptions) => {
      const child = spawnImpl(cmd as string, [...lead, ...o.args], { cwd: o.cwd, env: o.env, stdio: 'pipe', signal: o.signal })
      const err = (child as { stderr?: Readable | null }).stderr
      err?.setEncoding('utf8')
      err?.on('data', (chunk: string) => i.stderr?.(chunk))
      i.onChild?.(child)
      return child
    },
  }
}
