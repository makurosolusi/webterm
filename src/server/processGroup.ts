// Signal the process group a `detached: true` child leads (its shell, wrapper, grandchildren).
// The pid guard is the point: `process.kill(-(pid ?? 0))` with no pid (spawn failed) is kill(0), which
// signals THIS process's own group: under the native app that is the whole app.

/** Signal `child`'s group; without a real pid only the child handle is signalled. Never throws. */
export function killProcessGroup(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) { child.kill(signal); return }
  try { process.kill(-pid, signal) } catch { child.kill(signal) } // group gone/unsupported: signal the leader
}
