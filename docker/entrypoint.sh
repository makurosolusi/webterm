#!/usr/bin/env bash
# Container entrypoint (runs under tini). Prepares a short TMPDIR, checks volume access, loads Docker
# secrets, prints the "how do I sign in" hint once, then execs the server. Never prints secret values.
set -euo pipefail

# Unix socket paths are limited to 104 bytes (sun_path); a long TMPDIR breaks tmux and agent sockets.
export TMPDIR="${TMPDIR:-/tmp/st}"
mkdir -p "$TMPDIR"

# Docker/Compose secrets: /run/secrets/<name> fills the env var when the env does not already set it.
load_secret() { # <ENV_NAME> <secret file name>
  local file="/run/secrets/$2"
  if [ -z "${!1:-}" ] && [ -r "$file" ]; then
    export "$1=$(tr -d '\r\n' < "$file")"
  fi
}
load_secret ANTHROPIC_API_KEY anthropic_api_key
load_secret ANTHROPIC_AUTH_TOKEN anthropic_auth_token

# cap_drop ALL means we cannot chown, so only diagnose: fix ownership on the host instead.
data="${WEBTERM_DATA_DIR:-/data}"
for dir in "$data" /workspace "${HOME:-/home/webterm}"; do
  if [ ! -w "$dir" ]; then
    echo "webterm: $dir is not writable by uid $(id -u). Fix ownership on the host (chown -R $(id -u) <dir>) or set 'user:' in compose. See docs/docker.md." >&2
    exit 1
  fi
done

# The home volume hides the image's /home/webterm: seed missing skeleton files (never overwrite).
. /usr/local/share/webterm/seed-home.sh
seed_home /etc/skel "${HOME:-/home/webterm}"
mkdir -p "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# One-time hint (marker lives in the data volume). The server creates the token file on first boot.
if [ ! -e "$data/.docker-hint-shown" ]; then
  {
    echo "webterm: first start. The access token is a file, not a log line."
    echo "webterm: read it with: docker exec -it <container> sh -c 'cat $data/secrets/WEBTERM_TOKEN'"
    echo "webterm: then open http://127.0.0.1:${PORT:-8700} on the Docker host and create the first account."
  } >&2
  touch "$data/.docker-hint-shown" || true
fi

# Managed custom-command dir (WEBTERM_CUSTOM_BIN, on the data volume): owned by this user, private.
custom_bin="${WEBTERM_CUSTOM_BIN:-$data/custom-bin}"
mkdir -p "$custom_bin" && chmod 0700 "$custom_bin"

# Init hooks: $data/init.d/*.sh, by name, as this non-root user, before the server. A failure is logged
# (hook name + exit code only; this script never runs `env` or `set -x`) and the server still starts,
# unless the hook is named *.required.sh. Hook output is the hook's own: do not print secrets from hooks.
if [ -d "$data/init.d" ]; then
  for hook in "$data"/init.d/*.sh; do
    [ -f "$hook" ] || continue
    name="$(basename "$hook")"
    code=0
    bash "$hook" || code=$?
    if [ "$code" -ne 0 ]; then
      echo "webterm: init hook $name exited with code $code" >&2
      case "$name" in *.required.sh) echo "webterm: $name is required; not starting the server" >&2; exit "$code" ;; esac
    fi
  done
fi

exec "$@"
