#!/usr/bin/env bash
# Runs without Docker: bash docker/seed-home.test.sh. Checks seed_home fills gaps and never overwrites.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/seed-home.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/skel/sub" "$tmp/home"
echo skel-bashrc > "$tmp/skel/.bashrc"; echo skel-profile > "$tmp/skel/.profile"; echo nested > "$tmp/skel/sub/file"
echo mine > "$tmp/home/.bashrc"
seed_home "$tmp/skel" "$tmp/home"
[ "$(cat "$tmp/home/.bashrc")" = mine ] || { echo "FAIL: overwrote existing .bashrc" >&2; exit 1; }
[ "$(cat "$tmp/home/.profile")" = skel-profile ] || { echo "FAIL: missing .profile" >&2; exit 1; }
[ "$(cat "$tmp/home/sub/file")" = nested ] || { echo "FAIL: missing nested file" >&2; exit 1; }
seed_home "$tmp/skel" "$tmp/home" # idempotent second run
[ "$(cat "$tmp/home/.bashrc")" = mine ] || { echo "FAIL: second run overwrote" >&2; exit 1; }
echo "seed-home ok"
