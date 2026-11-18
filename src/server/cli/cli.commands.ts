// sh bodies of `webterm browser` and `webterm context`: the old `webterm-browser` and `context.sh`
// shims, moved verbatim into the CLI so those shims become one-line aliases (plan F2-b). Same identity
// model as before: curl reads the node's own header file (`-H @file`, path in WEBTERM_NODE_HEADERS);
// no token value is ever in argv or in the environment.
import { BROWSER_CONTROL_PREFIX, BROWSER_PROFILES_VERB, BROWSER_VERB_CAP } from '../../shared/browser.contract'
import { NODE_HEADERS_ENV } from '../hooksPaths'

// legacy: the `${NODETERM_PORT}` / `${NODETERM_NODE_ID}` fallbacks below serve tmux sessions started by a
// pre-rename server (their env is fixed for the session's life). Remove after 0.10.0.

const verbsOf = (cap: 'browser.read' | 'browser.act'): string =>
  Object.entries(BROWSER_VERB_CAP).filter(([, c]) => c === cap).map(([v]) => v).join('|')

/** `handoff` stays accepted for sessions that already know it, but is no longer advertised: act verbs take control themselves. */
const advertised = (cap: 'browser.read' | 'browser.act'): string => verbsOf(cap).split('|').filter((v) => v !== 'handoff').join('|')

/** JSON string escape (backslash, quote, tab, newlines); shared by `browser` and `skills get --json`. */
export const ESC_FN = `esc() { printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e 's/	/\\\\t/g' | awk 'NR>1{printf "\\\\n"}{printf "%s",$0}'; }`

/** `webterm browser <verb> [args] [--node <id>]`; the server picks the cabled browser at call time. */
export const BROWSER_COMMAND = `cmd_browser() {
usage() { echo "usage: webterm-browser <${advertised('browser.read')}|${advertised('browser.act')}> [args] [--node <browserNodeId>] | open|navigate [--profile <name>] | ${BROWSER_PROFILES_VERB}" >&2; exit 2; }
hdr="\${${NODE_HEADERS_ENV}:-}"
if [ -z "$hdr" ] || [ ! -r "$hdr" ]; then echo "Not a webterm agent session (no node credentials)." >&2; exit 2; fi
PORT="\${WEBTERM_PORT:-\${NODETERM_PORT:-8700}}"
[ "$#" -gt 0 ] || usage
verb="$1"; shift
node=""; profile=""; submit=0; loaded=0; ms=""; wref=""; n=0; p1=""; p2=""; p3=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --node) [ "$#" -ge 2 ] || usage; node="$2"; shift 2 ;;
    --profile) [ "$#" -ge 2 ] || usage; profile="$2"; shift 2 ;;
    --ms) [ "$#" -ge 2 ] || usage; ms="$2"; shift 2 ;;
    --ref) [ "$#" -ge 2 ] || usage; wref="$2"; shift 2 ;;
    --submit) submit=1; shift ;;
    --loaded) loaded=1; shift ;;
    *) n=$((n + 1)); case "$n" in 1) p1="$1" ;; 2) p2="$1" ;; 3) p3="$1" ;; *) usage ;; esac; shift ;;
  esac
done
case "$node" in *[!A-Za-z0-9_.:-]*) echo "bad node id" >&2; exit 2 ;; esac
num() { case "$1" in ""|*[!0-9.-]*) echo "numeric argument expected: $1" >&2; exit 2 ;; esac; }
[ -z "$ms" ] || num "$ms"
case "$verb" in scroll) num "$p1" ;; screenshot|console) [ -z "$p1" ] || num "$p1" ;; esac
case "$verb" in ${verbsOf('browser.read')}|${verbsOf('browser.act')}|${BROWSER_PROFILES_VERB}) ;; *) usage ;; esac
if [ -n "$profile" ]; then case "$verb" in open|navigate) ;; *) echo "--profile only applies to open and navigate" >&2; exit 2 ;; esac; fi
body="{}"
case "$verb" in
  screenshot) [ -z "$p1" ] || body="{\\"maxWidth\\":$p1}" ;;
  console)
    body="{"; sep=""
    [ -z "$p1" ] || { body="$body\${sep}\\"limit\\":$p1"; sep=","; }
    [ -z "$p2" ] || body="$body\${sep}\\"level\\":\\"$(esc "$p2")\\""
    body="$body}" ;;
  wait)
    body="{"; sep=""
    [ -z "$ms" ] || { body="$body\${sep}\\"ms\\":$ms"; sep=","; }
    [ -z "$wref" ] || { body="$body\${sep}\\"selectorRef\\":\\"$(esc "$wref")\\""; sep=","; }
    [ "$loaded" = 0 ] || body="$body\${sep}\\"loaded\\":true"
    body="$body}" ;;
  open|navigate)
    [ "$verb" = open ] || [ -n "$p1" ] || usage
    body="{"; sep=""
    [ -z "$p1" ] || { body="$body\${sep}\\"url\\":\\"$(esc "$p1")\\""; sep=","; }
    [ -z "$profile" ] || body="$body\${sep}\\"profile\\":\\"$(esc "$profile")\\""
    body="$body}" ;;
  click) [ -n "$p2" ] || usage; body="{\\"ref\\":\\"$(esc "$p1")\\",\\"snapId\\":\\"$(esc "$p2")\\"}" ;;
  type)
    [ -n "$p3" ] || usage
    body="{\\"ref\\":\\"$(esc "$p1")\\",\\"snapId\\":\\"$(esc "$p2")\\",\\"text\\":\\"$(esc "$p3")\\""
    [ "$submit" = 0 ] || body="$body,\\"submit\\":true"
    body="$body}" ;;
  press) [ -n "$p1" ] || usage; body="{\\"key\\":\\"$(esc "$p1")\\"}" ;;
  scroll) [ -n "$p1" ] || usage; body="{\\"dy\\":$p1}" ;;
esac
url="http://127.0.0.1:$PORT${BROWSER_CONTROL_PREFIX}/\${node:+$node/}$verb"
if [ "$verb" = status ] || [ "$verb" = ${BROWSER_PROFILES_VERB} ]; then method=GET; else method=POST; fi
curl -sS -H "@$hdr" -X "$method" \\
  -H "content-type: application/json" --data-binary "$body" "$url"
echo
}`

/** `webterm context [list|summary|transcript|terminal] [--node X] [-n N]`; the server reads and renders. */
export const CONTEXT_COMMAND = `cmd_context() {
NODE_ID="\${WEBTERM_NODE_ID:-\${NODETERM_NODE_ID:-}}"
if [ -z "$NODE_ID" ]; then
  echo "Not a webterm session (WEBTERM_NODE_ID unset) — nothing to read."
  exit 0
fi
hdr="\${${NODE_HEADERS_ENV}:-}"
if [ -z "$hdr" ] || [ ! -r "$hdr" ]; then
  echo "Not a webterm agent node (no node credentials) — nothing to read."
  exit 0
fi
PORT="\${WEBTERM_PORT:-\${NODETERM_PORT:-8700}}"
verb="\${1:-list}"; [ "$#" -gt 0 ] && shift
want=""; n=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --node) want="$2"; shift 2 ;;
    -n) n="$2"; shift 2 ;;
    *) shift ;;
  esac
done
curl -s --get \\
  -H "@$hdr" \\
  --data-urlencode "node=\${NODE_ID}" \\
  --data-urlencode "verb=\${verb}" \\
  --data-urlencode "want=\${want}" \\
  --data-urlencode "n=\${n}" \\
  "http://127.0.0.1:\${PORT}/api/context-link"
}`
