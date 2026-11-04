// macOS PTY exit deadlock guard.
//
// Root cause (reproduced; same pattern reported for Ruby on macOS): when the SESSION LEADER of a tty
// exits, XNU drains that tty's output queue first (`ttywait`, no timeout, not interruptible), so a
// leader whose last output is still unread sits in state `E` until someone reads the PTY master.
// `Bun.spawn({ terminal })` makes our child that leader, and Bun reaps it with a blocking `waitpid`
// as soon as the exit starts. The master is read only by Bun's event loop, which is now blocked:
// child waits for Bun, Bun waits for child, the whole server freezes at 0% CPU (no timer can fire).
//
// Fix: never let the leader exit with output queued. The leader becomes this tiny guard: it forks
// the real argv (same session, same foreground group, so job control, Ctrl+C and SIGWINCH reach
// it unchanged), waits for it, then `tcdrain`s the tty BEFORE exiting. While the guard drains it is
// still alive, so Bun's loop runs and reads the master; when the guard finally exits the queue is
// empty and `ttywait` returns at once. `tcdrain` is capped by an alarm so the guard always ends.
// Linux does not wait on the tty in exit, so the guard is macOS-only.
import { existsSync } from 'node:fs'

/** System perl: ships with macOS, POSIX::tcdrain is in core. Absent = no guard (old behaviour). */
export const DRAIN_GUARD_PERL = '/usr/bin/perl'
/** Upper bound of the drain wait; past it the guard exits anyway (bounded, never hangs itself). */
export const DRAIN_GUARD_MAX_S = 5

// The guard ignores job-control and keyboard signals (they target the child's group, which the
// guard shares until an interactive shell makes its own), forwards SIGTERM to the child, and exits
// with the child's status (signal death = 128 + n, as Bun reports it). The child gets default
// handlers back: `exec` resets caught ones, and the ignores are set only after the fork.
const GUARD_SCRIPT = [
  'use POSIX ();',
  'my $pid = fork();',
  'die "webterm pty guard: fork failed: $!\\n" unless defined $pid;',
  'if ($pid == 0) { exec { $ARGV[0] } @ARGV; print STDERR "webterm pty guard: cannot run $ARGV[0]: $!\\n"; POSIX::_exit(127) }',
  '$SIG{$_} = "IGNORE" for qw(INT QUIT TSTP TTIN TTOU);',
  '$SIG{TERM} = sub { kill "TERM", $pid };',
  '$SIG{HUP} = sub { kill "HUP", $pid };',
  'my $r; do { $r = waitpid($pid, 0) } while ($r == -1 && $!{EINTR});',
  'my $st = $?;',
  `$SIG{ALRM} = sub {}; alarm ${DRAIN_GUARD_MAX_S}; POSIX::tcdrain(1); alarm 0;`,
  'POSIX::_exit(($st & 127) ? 128 + ($st & 127) : ($st >> 8));',
].join(' ')

/** `argv` wrapped in the drain guard where it is needed (macOS with system perl), else unchanged. */
export function drainGuardArgv(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
  hasPerl: () => boolean = () => existsSync(DRAIN_GUARD_PERL),
): string[] {
  if (platform !== 'darwin' || argv.length === 0 || !hasPerl()) return argv
  return [DRAIN_GUARD_PERL, '-e', GUARD_SCRIPT, '--', ...argv]
}
