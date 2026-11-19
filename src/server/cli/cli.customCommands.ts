// sh body of `webterm command ...` for agent sessions (inside the generated launcher, like cmd_browser).
// list/detect/add/remove are the registry capabilities `command.*`, so every call goes through the same
// policy gate and receipt as any other capability; add/remove also hit human-UI-only routes, so an agent
// cannot register a command even if a rule allowed it. `which` only asks this session's own PATH.
// A person at a terminal uses the server binary instead (customCommands.cli.ts).

/** Needs `die`, `esc`, `session`, `send` and `cmd_call` from the launcher. */
export const COMMAND_SH = `cmd_command() {
verb="$1"; [ "$#" -gt 0 ] && shift
case "$verb" in
  list) cmd_call command.list ;;
  detect) cmd_call command.detect ;;
  rescan) cmd_call command.rescan ;;
  path)
    sub="$1"; [ "$#" -gt 0 ] && shift
    case "$sub" in
      list|"") cmd_call command.paths ;;
      add) [ -n "$1" ] || die "usage: webterm command path add <dir>"; cmd_call command.path_add --json "{\\"dir\\":\\"$(esc "$1")\\"}" ;;
      remove) [ -n "$1" ] || die "usage: webterm command path remove <dir>"; cmd_call command.path_remove --json "{\\"dir\\":\\"$(esc "$1")\\"}" ;;
      *) die "usage: webterm command path list | add <dir> | remove <dir>" ;;
    esac ;;
  which)
    [ -n "$1" ] || die "usage: webterm command which <name>"
    command -v -- "$1" || { echo "$1 not found"; exit 1; } ;;
  remove)
    [ -n "$1" ] || die "usage: webterm command remove <name>"
    cmd_call command.remove --json "{\\"name\\":\\"$(esc "$1")\\"}" ;;
  add)
    name="$1"; [ "$#" -gt 0 ] && shift
    [ -n "$name" ] || die "usage: webterm command add <name> --link <abs-path> | --shim [--note <t>] [--force] -- <program> [args...]"
    kind=""; target=""; note=""; force=""; argv=""; sep=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --link) [ "$#" -ge 2 ] || die "--link needs a path"; kind=link; target="$2"; shift 2 ;;
        --shim) kind=shim; shift ;;
        --note) [ "$#" -ge 2 ] || die "--note needs text"; note="$2"; shift 2 ;;
        --force) force=1; shift ;;
        --) shift; while [ "$#" -gt 0 ]; do argv="$argv$sep\\"$(esc "$1")\\""; sep=","; shift; done ;;
        *) die "unknown option: $1" ;;
      esac
    done
    [ -n "$kind" ] || die "add needs --link <abs-path> or --shim -- <program> [args...]"
    body="{\\"name\\":\\"$(esc "$name")\\",\\"kind\\":\\"$kind\\""
    [ -z "$target" ] || body="$body,\\"target\\":\\"$(esc "$target")\\""
    [ "$kind" != shim ] || body="$body,\\"argv\\":[$argv]"
    [ -z "$note" ] || body="$body,\\"note\\":\\"$(esc "$note")\\""
    [ -z "$force" ] || body="$body,\\"force\\":true"
    cmd_call command.add --json "$body}" ;;
  *) die "usage: webterm command list | detect | rescan | path ... | which <name> | add <name> ... | remove <name>" ;;
esac
}`
