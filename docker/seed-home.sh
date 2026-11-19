#!/usr/bin/env bash
# Sourced by entrypoint.sh. seed_home <skel dir> <home dir>: copy skeleton files that do not exist yet.
# Existing files are never overwritten (a user's rc files, installer edits and git config survive).
seed_home() {
  local skel="$1" home="$2" src rel dest
  [ -d "$skel" ] || return 0
  mkdir -p "$home"
  while IFS= read -r -d '' src; do
    rel="${src#"$skel"/}"
    dest="$home/$rel"
    if [ -d "$src" ]; then
      mkdir -p "$dest"
    elif [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
      cp -P "$src" "$dest"
    fi
  done < <(find "$skel" -mindepth 1 -print0)
}
