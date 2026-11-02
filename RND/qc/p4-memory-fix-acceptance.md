# P4 memory-file fixes — cold-root acceptance

Date: 2026-11-01 · Branch: `feature/agent-pusat-p3` @ `2176c98`
Scope: prove the memory QC fixes on a real cold root (no manual `mkdir`, no `git init`, no host
git identity). No repo source/test was edited and nothing was committed. All state under
`/tmp/wt-p4fix-*` (removed after the run). Server: `NODE_ENV=production`, ports 8825 (on) and
8826 (flag off) only; 8799/3001 untouched.

Token redacted: `$TOKEN` = 48-hex root token read from `$ACC/token.txt`. It never appears below,
and a full-text scan of every non-token file under `$ACC` (including both server logs) returned
**no hits** for the literal token and **0** matches for `[0-9a-f]{48}` in the logs.

## Setup (all temp, outside the repo)

```sh
ACC=$(mktemp -d /tmp/wt-p4fix-XXXXXX)          # /tmp/wt-p4fix-gNSUQj
mkdir -p "$ACC/home" "$ACC/data"               # NO memory dir was created
openssl rand -hex 24 > "$ACC/token.txt"        # len 48
test -e "$ACC/home/.gitconfig"                 # -> absent; HOME is a brand-new dir
# boot (cwd /tmp, env -i: no repo .env, no global git config)
cd /tmp
env -i PATH="$PATH" HOME="$ACC/home" HOST=127.0.0.1 PORT=8825 NODE_ENV=production \
  WEBTERM_DATA_DIR="$ACC/data" WEBTERM_LEDGER=on WEBTERM_MEMORY_FILES=on \
  WEBTERM_MEMORY_DIR="$ACC/memory" WEBTERM_TOKEN="$TOKEN" \
  nohup bun /Users/bip/Documents/spawn/webterm/src/server/index.ts > "$ACC/server-8825.log" 2>&1 &
```

Boot log:
```
ledger on: /tmp/wt-p4fix-gNSUQj/data/ledger.db
webterm listening on http://127.0.0.1:8825 (prod, token on: len=48)
--- memory exists? NO
```

Seeded after boot with temp Bun scripts importing the real repo modules (`openLedgerDb` +
`supersedeMemory`) from absolute paths; scripts lived in `$ACC`, never in the repo. Rows inserted
with `status='fact'`, `created_at = now-60s`:

| id | project/scope/key | body |
|---|---|---|
| `mem-project-deploy` | p1/project/deploy | `Deploy via zeus.` |
| `mem-scratch-deploy` | p1/scratch/deploy | `Scratch deploy notes.` |
| `mem-rollout-old` | p1/project/rollout | `OLD rollout body` |

## 1 + 2. Two scoped exports on a cold root — VERIFIED

```sh
curl -X POST -H "x-webterm-token: $TOKEN" -H 'content-type: application/json' \
     -d '{"id":"mem-project-deploy"}' $B/api/memory/export
# HTTP 200 {"ok":true,"status":"written","relPath":"p1/project/deploy.md"}
curl ... -d '{"id":"mem-scratch-deploy"}' $B/api/memory/export
# HTTP 200 {"ok":true,"status":"written","relPath":"p1/scratch/deploy.md"}
```

Distinct relPaths confirmed: same key `deploy`, different scope, two files — not one shared path
(`memoryFileRelPath`, `src/server/memory/memoryFilePath.ts:67`).

Cold-root evidence (nothing was created by hand before the first export):

```sh
stat -f '%Sp %N' "$ACC/memory"
# drwx------ /tmp/wt-p4fix-gNSUQj/memory          -> auto-created 0700
stat -f '%Sp %N' "$ACC/memory/p1" \
  "$ACC/memory/p1/project/deploy.md" "$ACC/memory/p1/scratch/deploy.md"
# drwx------ .../memory/p1
# -rw------- .../memory/p1/project/deploy.md     -> 0600
# -rw------- .../memory/p1/scratch/deploy.md     -> 0600
test -d "$ACC/memory/.git" && echo YES
# YES                                             -> git init ran
git -C "$ACC/memory" log --format='%h %an <%ae> %s'
# c2fb7b1 webterm <webterm@localhost> memory(p1): record fact deploy
# e414e3c webterm <webterm@localhost> memory(p1): record fact deploy
```

Identity is server-owned (`src/server/memory/memoryFile.ts:38`, passed as `-c user.name/-c
user.email` at `:90`), proven by `$ACC/home/.gitconfig` staying absent after the run. Repo is clean
(`git status --porcelain` empty). File body is the rendered Markdown frontmatter + title + body.

## 3. Supersede + rebuild must not roll back — VERIFIED

```sh
# export the OLD fact first
curl ... -d '{"id":"mem-rollout-old"}' $B/api/memory/export
# HTTP 200 {"ok":true,"status":"written","relPath":"p1/project/rollout.md"}
tail -1 "$ACC/memory/p1/project/rollout.md"        # OLD rollout body
# supersede via the real repository function (temp script)
DB="$ACC/data/ledger.db" bun "$ACC/supersede.ts"
# {"next":{"id":"f270...","key":"rollout","status":"fact","body":"NEW rollout body",
#          "supersedes":"mem-rollout-old","updatedAt":1793516264921},
#  "old":{"key":"rollout#superseded:mem-rollout-old","status":"superseded",...},
#  "live":[{"id":"f270...","key":"rollout","status":"fact","body":"NEW rollout body"}]}
# rebuild while the OLD file is still on disk
curl ... -d '{}' $B/api/memory/rebuild
# HTTP 200 {"ok":true,"status":"rebuilt","projectId":null,"scanned":3,"inserted":0,
#           "updated":0,"unchanged":3,"quarantined":[],"quarantinedCount":0,
#           "rejected":[],"rejectedCount":0}
# live row read independently of the server:
[{"id":"f270...","key":"rollout","status":"fact","body":"NEW rollout body","updated_at":1793516264921}]
```

No rollback: the stale file is older than the live row, so it is counted `unchanged` and skipped
(`src/server/memory/memoryFile.ts:130`). Export of the new row overwrote the file and committed:

```sh
curl ... -d '{"id":"f270..."}' $B/api/memory/export
# HTTP 200 {"ok":true,"status":"written","relPath":"p1/project/rollout.md"}
tail -3 "$ACC/memory/p1/project/rollout.md"
# # Rollout v2
#
# NEW rollout body
grep -c 'NEW rollout body' .../rollout.md   # 1
grep -c 'OLD rollout body' .../rollout.md   # 0
git -C "$ACC/memory" log --format='%h %an <%ae> %s' -- p1/project/rollout.md
# 2f158be webterm <webterm@localhost> memory(p1): record fact rollout
# 229d451 webterm <webterm@localhost> memory(p1): record fact rollout
git -C "$ACC/memory" status --porcelain | wc -l    # 0 (clean)
# second rebuild after the new export: identical report, live body still NEW
```

## 4. Flag off on 8826 — VERIFIED

Second instance, `WEBTERM_LEDGER=on` but `WEBTERM_MEMORY_FILES` unset, empty data dir,
`WEBTERM_MEMORY_DIR="$ACC/memory-off"` (nonexistent):

```sh
curl -X POST ... $B2/api/memory/export  -d '{"id":"mem-project-deploy"}'
# HTTP 503 {"error":"memory_files_off"}
curl -X POST ... $B2/api/memory/rebuild -d '{}'
# HTTP 503
test -e "$ACC/memory-off" && echo YES || echo NO      # NO  -> no filesystem touch
```

Gate answered before any ledger/body/DB work (`src/server/extendedApi.ts:98-100`); `data8826`
contains only the ledger DB and boot artifacts (`context-links`, `webterm.db`), no `memory` dir.

## 5. Leak scan + cleanup — VERIFIED

```sh
grep -rl -F "$TOKEN" "$ACC" --exclude=token.txt   # no hits
grep -rEo '[0-9a-f]{48}' "$ACC"/server-882*.log   # 0 matches
# logs each 2 lines: "ledger on: <data>/ledger.db" + "webterm listening ... (token on: len=48)"
kill $(cat "$ACC/pid-8825") $(cat "$ACC/pid-8826")   # both processes stopped
rm -rf "$ACC"                                        # temp state removed
```

## Verdict

| Item | Result |
|---|---|
| 1. Cold-root boot + seed + scoped exports (distinct relPaths) | **VERIFIED** |
| 2. Root auto-created 0700, `git init`, files 0600, commit w/o host git config | **VERIFIED** |
| 3. Supersede + rebuild no rollback; re-export writes NEW | **VERIFIED** |
| 4. Flag off → 503 `memory_files_off`, no FS touch | **VERIFIED** |
| 5. No token/secret in logs; cleanup done | **VERIFIED** |

Bugs found: **none.** No behavioral regression was observed in the exercised paths.
Constraints met: repo source/tests untouched, no commit, only `/tmp` state and ports 8825/8826.
Caveat: static inspection plus this live run; paths not exercised (e.g. symlink escape, rebuild
conflict quarantine, export of a superseded id) are outside this acceptance.
