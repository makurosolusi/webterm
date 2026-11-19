# Custom commands

Users register commands such as `envman`, `op` or `doppler` once; every webterm terminal, agent launch
and the server's own checks (`binaryExists`, doctor, claude preflight) then find them.

## Design

- **Managed bin dir** `customBinDir`: `WEBTERM_CUSTOM_BIN`, default `<WEBTERM_DATA_DIR>/custom-bin`, created
  0700. Docker sets `WEBTERM_CUSTOM_BIN=/data/custom-bin`; no code assumes another location. A read-only
  dir makes add/remove answer `bin_dir_readonly` (HTTP 503); it is still searched.
- **Registry** `<dataDir>/custom-commands.json` (atomic tmp+rename, 0600) plus one file per command in the
  bin dir. Entries: `{ name, kind: 'link' | 'shim', target | argv, note?, addedAt }`. Limits: 64 entries,
  32 argv items of 512 chars. Contract, validators and the shim renderer: `src/shared/customCommands.ts`.
- **PATH**: one rule, `withCustomBin` (`customBinPath.ts`): applied in `ptyEnv` (every shell, tmux session,
  agent launch, git/lsp child) and once at boot to the server's own PATH (`bootCustomBin`, after the login
  shell merge, so it stays first). Login shells keep inherited PATH entries (macOS `path_helper` reorders
  but does not drop them), so the dir survives `-l`. Ceiling: an rc file that overwrites PATH wholesale
  removes it, and in an interactive macOS login shell a *system* binary of the same name can win over a
  custom command because `path_helper` puts system dirs first. New names (envman, op) are unaffected.
- **link** = symlink to an existing absolute path that is an executable regular file, not inside the bin
  dir. **shim** = a tiny `sh` script `exec 'prog' 'arg'... "$@"`.

## Why

- **Managed PATH, not editing rc files.** Editing `.zshrc` and friends is invasive, shell-specific and breaks
  on Docker; one directory that webterm owns and puts first works for all shells and for the server itself.
- **Shim, not alias.** Aliases exist only in interactive shells of one dialect; agents launch through
  `sh -c`/`-l -c` and tools exec directly. A file on PATH works everywhere. Every word is single-quoted
  (`'` becomes `'\''`): no `eval`, no interpolation of user text, so `; rm -rf` stays a literal argument.
  A shim whose own name appears in its argv (the `claude` wrapping `claude` case) drops the bin dir from
  PATH before `exec`, otherwise it would find itself and loop.
- **No secrets stored.** A shim holds argv only (`envman run -- claude`); the wrapper fetches secrets at
  run time. The registry never contains env values.
- **Never executed to list.** `list`/`which`/`detect` only check existence and the executable bit. A
  registered command is code of the user's choosing; probing it with `--version` would run it on every
  Settings page load.
- **Names.** `^[a-z0-9][a-z0-9._-]{0,63}$`. Core tools (`sh bash zsh fish ls cat rm cp mv sudo su ssh git
  tmux bun node npm webterm`) can never be replaced. `claude` is allowed only with `force`, since webterm
  launches it. Duplicates need `force`.

## Surfaces and approval class

- HTTP: `GET/POST /api/custom-commands`, `POST /api/custom-commands/remove`, `DELETE /api/custom-commands/:name`,
  `GET .../which?name=`, `GET .../detect`. Mutations are human-UI only (`uiOnly`).
- Capabilities `command.list`, `command.detect` (R0) and `command.add`, `command.remove` (R2: shared mutation,
  the class of `git.scm.commit`). Agents call them through the usual policy gate; the mutating routes are
  human-UI only, so there is no agent path around it.
- CLI: `webterm command list|add|remove|which|detect`. A person's terminal runs the server binary directly
  on the data dir (no server needed). In an agent session the launcher script maps `list`/`detect` to the
  capabilities, `add`/`remove` are denied, `which` asks the session's own PATH.
- Every add/remove logs `custom_command.added` / `custom_command.removed` (name and kind only).

## Revision: installed means callable (no registration)

Registering a command is optional and only needed for a **shim** (a fixed argv such as `envman run -- claude`)
or a **link** under another name. A tool that is merely installed must work in every terminal and launcher.
The cause of "installed but not found" was that the login-shell PATH is merged once at boot, so anything
installed (or added to PATH in an rc file) afterwards was invisible to the server, the agent launcher and
doctor, and `unwrapMissingWrapper` then dropped the wrapper without saying why.

- **One resolver** (`pathResolver.ts`), used by `binaryExists` (so doctor, launchers, `unwrapMissingWrapper`) and
  `ptyEnv`. A miss is not trusted: before concluding "missing" it (1) re-reads the extra dirs from the sidecar,
  (2) scans the usual tool dirs (`~/.local/bin ~/bin ~/go/bin ~/.cargo/bin ~/.bun/bin ~/.deno/bin /usr/local/bin
  /opt/homebrew/bin /opt/local/bin /opt/custom/bin`, only existing and not world-writable), (3) looks one level
  under HOME (`~/.*/bin`, `~/{go,bin,opt}/bin`; installer one-liners put tools there and edit rc files for NEW
  shells only), and (4) re-runs the login shell in the background (async, existing 5 s timeout) for the next
  lookup. Found directories are appended to the server's PATH. Each name is refreshed at most once per 15 s
  (that map is the short-TTL negative cache); `rescan` clears it and awaits the login shell.
- **HOME probe bounds**: sorted, at most 64 directories, 200 ms total, never follows a symlink out of HOME,
  skips world-writable dirs and binaries for another OS/arch, reads only names and headers, never executes.
  A hit is added to PATH for this server run only (not persisted) and the user is told:
  "`<cmd>` was found in `~/.x/bin` and added to PATH for this session. Add it permanently: ..." (the notice is
  printed into the terminal being opened; `GET /api/custom-commands/paths` lists these as `session` for a UI action
  that calls `POST /paths`).
- **Extra dirs** (`extraPathDirs` in the sidecar, max 16): `webterm command path add|remove|list`,
  `GET/POST /api/custom-commands/paths`, `POST .../paths/remove`, `DELETE .../paths?dir=`. Absolute, normalized,
  existing directory, not world-writable (refused with `unsafe_path_dir`: anyone could plant a program there).
  PATH order: managed dir, then the extra dirs, then the rest. One folder = every tool in it found everywhere.
- **Auto-discovery** (`GET /api/custom-commands/detect`, `webterm command detect`): every executable in the
  managed + extra dirs plus the common wrappers (found or not), each with `source` (`custom-bin|extra|path|candidate`),
  `format`, `compat`. Nothing is run.
- **Never silent**: `unwrapMissingWrapper` still degrades to the bare command so the node starts, but the terminal
  shows "`x` was not found - launched without it. If you just installed it, run `webterm command rescan`" (or the
  platform-mismatch message below) and the server logs `spawn.wrapper_dropped` with the command name only.
- **Ceiling**: `webterm command rescan` run by a person is a separate process and cannot refresh a running server;
  the server refreshes itself on the first miss, and `POST /api/custom-commands/rescan` (Settings) is instant.
  Removing an extra dir drops it from the server PATH at the next scan; shells already open keep their env.

## Revision: one folder for every platform, wrong-platform detection

- **Header sniffing** (`binaryFormat.ts`): ELF, Mach-O (thin and universal), PE and `#!` scripts, with arch
  (arm64 / amd64) when readable. `compat`: `ok | wrong_platform | wrong_arch | unknown`. Apple Silicon accepts
  amd64 (Rosetta). A found binary that does not fit this machine is never launched: the wrapper check treats it
  as unusable and the notice says, e.g., "envman is a macOS arm64 binary; this machine is linux/arm64 - add a
  linux-arm64 build next to it".
- **Platform subfolder**: for the managed dir and every extra dir, a child `<os>-<arch>` matching this machine
  (`darwin-arm64 darwin-amd64 linux-arm64 linux-amd64`) is put on PATH right before its parent. Put
  `darwin-arm64/tool` and `linux-arm64/tool` in the same folder and it works on the host and in Docker.
