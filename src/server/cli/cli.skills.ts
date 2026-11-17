// sh body of `webterm skills ...` (list | propose | edit | get). `get` serves the version-matched guides without
// contacting the server; the other three call the `skills.list` / `skills.propose` capabilities with the node's own
// header file (like every other verb), so the token is never in argv. An agent can only PROPOSE: the one-line
// answer always says a human must approve, and nothing here can activate, enable, disable or reject a skill.
// Uses launcher helpers `die`, `esc`, `session` (sets `$API`, `$hdr`) and `$SKILLS_DIR`. Written with String.raw and
// no sh parameter expansions with braces on purpose, so the sh reads exactly as it runs (the only interpolation is SKILLS_USAGE).
export const SKILLS_USAGE = 'usage: webterm skills <list [name] | propose --name <webterm-slug> --description <text> [--audience canvas] [--caps a,b] [--body-file <path>|-] | edit <name> [--description <text>] [--caps a,b] [--body-file <path>|-] | get <name> [--json]>'

export const SKILLS_COMMAND = String.raw`skills_get() {
  name="$1"
  case "$name" in ""|*[!a-z0-9-]*) die "usage: webterm skills get <name> [--json]" ;; esac
  f="$SKILLS_DIR/$name.md"
  if [ ! -r "$f" ]; then
    # Not a launcher guide: ask the server for an approved canvas skill (audience canvas).
    session
    if [ "$2" = --json ]; then acc='accept: application/json'; else acc='accept: text/plain'; fi
    resp=$(curl -sS -H "@$hdr" -H "$acc" -H 'content-type: application/json' --data-binary '{"name":"'"$name"'"}' -w '\n%{http_code}' "$API/skills.list") || exit 1
    code=$(printf '%s\n' "$resp" | tail -n 1)
    case "$code" in 2*) printf '%s\n' "$resp" | sed '$d'; exit 0 ;; esac
    echo "Unknown skill: $name. Available:" >&2
    for g in "$SKILLS_DIR"/*.md; do [ -r "$g" ] && { g=$(basename "$g" .md); echo "  $g" >&2; }; done
    echo "  (run: webterm skills list, for the approved canvas skills)" >&2
    exit 2
  fi
  if [ "$2" = --json ]; then
    ver=$(sed -n 's/^version: //p' "$f" | head -n 1)
    printf '{"name":"%s","version":"%s","markdown":"%s"}\n' "$name" "$(esc "$ver")" "$(esc "$(cat "$f")")"
  else
    cat "$f"
  fi
}
skills_write() {
  verb="$1"; shift
  name=""; desc=""; has_desc=0; caps=""; bf=""; has_body=0; aud=""
  if [ "$verb" = edit ]; then name="$1"; [ "$#" -gt 0 ] && shift; fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --name) [ "$verb" = propose ] && [ "$#" -ge 2 ] || die "${SKILLS_USAGE}"; name="$2"; shift 2 ;;
      --description) [ "$#" -ge 2 ] || die "${SKILLS_USAGE}"; desc="$2"; has_desc=1; shift 2 ;;
      --audience) [ "$#" -ge 2 ] || die "${SKILLS_USAGE}"; aud="$2"; shift 2 ;;
      --caps) [ "$#" -ge 2 ] || die "${SKILLS_USAGE}"; caps="$2"; shift 2 ;;
      --body-file) [ "$#" -ge 2 ] || die "${SKILLS_USAGE}"; bf="$2"; has_body=1; shift 2 ;;
      *) die "${SKILLS_USAGE}" ;;
    esac
  done
  case "$name" in ""|*[!a-z0-9-]*) die "${SKILLS_USAGE}" ;; esac
  case "$aud" in ""|canvas) ;; central) die "agents cannot write central skills (rules Central loads); only canvas skills" ;; *) die "--audience can only be canvas" ;; esac
  if [ "$verb" = propose ]; then [ "$has_desc" = 1 ] && [ "$has_body" = 1 ] || die "propose needs --description and --body-file (a path, or - for stdin)"; fi
  if [ "$verb" = edit ]; then [ "$has_desc" = 1 ] || [ "$has_body" = 1 ] || [ -n "$caps" ] || die "edit needs at least one of --description, --body-file, --caps"; fi
  json='{"name":"'"$name"'"'
  [ "$has_desc" = 0 ] || json="$json"',"description":"'"$(esc "$desc")"'"'
  if [ "$has_body" = 1 ]; then
    if [ "$bf" = - ]; then body=$(tr -d '\r'); else [ -r "$bf" ] || die "cannot read $bf"; body=$(tr -d '\r' < "$bf"); fi
    json="$json"',"body":"'"$(esc "$body")"'"'
  fi
  if [ -n "$caps" ]; then
    arr=""; oldifs="$IFS"; IFS=,
    for c in $caps; do
      case "$c" in ""|*[!A-Za-z0-9._-]*) IFS="$oldifs"; die "bad capability name in --caps" ;; esac
      [ -z "$arr" ] || arr="$arr,"
      arr="$arr"'"'"$c"'"'
    done
    IFS="$oldifs"; json="$json"',"caps":['"$arr"']'
  fi
  [ -z "$aud" ] || json="$json"',"audience":"'"$aud"'"'
  [ "$verb" = edit ] && json="$json"',"edit":true'
  json="$json"'}'
  session
  resp=$(curl -sS -H "@$hdr" -H 'content-type: application/json' --data-binary "$json" -w '\n%{http_code}' "$API/skills.propose") || exit 1
  code=$(printf '%s\n' "$resp" | tail -n 1)
  out=$(printf '%s\n' "$resp" | sed '$d')
  case "$code" in
    2*)
      case "$out" in *'"state":"rejected"'*) echo "not accepted: evaluation rejected the draft; nothing was activated" >&2; exit 1 ;; esac
      ver=$(printf '%s' "$out" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
      echo "proposed $name v$ver; a human must approve it in webterm (nothing is active yet)"; exit 0 ;;
    *)
      detail=$(printf '%s' "$out" | sed -n 's/.*"detail":"\([^"]*\)".*/\1/p')
      [ -n "$detail" ] || detail="http_$code"
      issues=$(printf '%s' "$out" | sed -n 's/.*"issues":\[\([^]]*\)\].*/\1/p')
      echo "not proposed: $detail" >&2
      [ -z "$issues" ] || echo "lint issues: $issues" >&2
      exit 1 ;;
  esac
}
cmd_skills() {
  sub="$1"; [ "$#" -gt 0 ] && shift
  case "$sub" in
    get) skills_get "$@" ;;
    propose|edit) skills_write "$sub" "$@" ;;
    list)
      body='{}'
      if [ "$#" -gt 0 ]; then
        case "$1" in ""|*[!a-z0-9-]*) die "${SKILLS_USAGE}" ;; esac
        body='{"name":"'"$1"'"}'
      fi
      session
      send -X POST -H 'content-type: application/json' --data-binary "$body" "$API/skills.list" ;;
    *) die "${SKILLS_USAGE}" ;;
  esac
}`
