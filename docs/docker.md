# Running webterm in Docker

The image bundles the Bun server with the built UI, tmux, git, ssh client, Node.js, a pinned Claude Code CLI and a pinned Chrome for Testing. No credential is ever baked into the image.

## Quickstart

```sh
export ANTHROPIC_API_KEY=sk-ant-...        # optional: see "Claude authentication"
export WEBTERM_PROJECTS=$HOME/code         # optional: host folder shown as /workspace (default ./workspace)
docker compose up -d --build
docker compose logs webterm | head         # first start prints how to read the access token
docker exec -it webterm sh -c 'cat /data/secrets/WEBTERM_TOKEN; echo; cat /data/secrets/SETUP_CODE'
```

Open `http://127.0.0.1:8700` on the Docker host and create the first account with the setup code. The port is published on loopback only. To reach it remotely, use an SSH tunnel or a reverse proxy with TLS; do not publish it on `0.0.0.0`.

## Published image (no build)

`compose.ghcr.yml` runs the image from `ghcr.io/makurosolusi/webterm` without a repo checkout. The seccomp profile is a local file, so fetch the one from the SAME tag as the image:

```sh
TAG=0.9.3
curl -fsSLO https://raw.githubusercontent.com/makurosolusi/webterm/v$TAG/docker/chrome.seccomp.json
curl -fsSLO https://raw.githubusercontent.com/makurosolusi/webterm/v$TAG/compose.ghcr.yml
WEBTERM_IMAGE_TAG=$TAG docker compose -f compose.ghcr.yml up -d
```

- **Tags:** `x.y.z`, `x.y`, `latest` (stable releases only) and `sha-<short>`. Pin `WEBTERM_IMAGE_TAG` to `x.y.z` for reproducible deployments; `pull_policy: always` re-checks the tag on every `up`. Point `WEBTERM_SECCOMP` elsewhere if the profile is not next to the compose file.
- **Visibility:** a new GHCR package is private by default. Change it under GitHub > Packages > the package > Package settings. For a private image run `docker login ghcr.io` first with a token that has `read:packages`.
- **Releasing:** update `CHANGELOG.md`, then push tag `v0.9.3` (matching `package.json`). `.github/workflows/docker-publish.yml` builds, runs the smoke test (healthcheck, `claude --version`, Chrome `--version`, custom-command PATH; no real page), and only then pushes `linux/amd64` + `linux/arm64` with provenance and SBOM. The workflow can also be started manually.

## Browser per architecture

| Architecture | Browser | Source | Version |
| --- | --- | --- | --- |
| amd64 | Chrome for Testing | `scripts/fetch-chrome.ts` | pinned and checksummed |
| arm64 (Apple Silicon Docker, ARM servers) | Debian `chromium` | apt, bookworm (security) | follows Debian (156.x when checked), not pinned |

Chrome for Testing publishes no linux arm64 build, so arm64 images use Debian's package (verified to exist for arm64 on packages.debian.org/bookworm/chromium). Open limitation: arm64 is not a locked Chrome for Testing build, so the browser version can differ between the two images and between rebuilds. Both are reachable as `chrome` (`WEBTERM_BROWSER_BIN=/usr/local/bin/chrome`) and run with the sandbox on.

## Claude authentication

- **Default: API key or proxy.** Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`) in the host shell or in an untracked `.env` next to `docker-compose.yml`. Compose passes them through; the compose file holds no values. Docker secrets also work: mount a secret named `anthropic_api_key` (and/or `anthropic_auth_token`) and the entrypoint exports it when the env var is unset.
- **Alternative: `claude login` in the container.** `docker exec -it webterm claude login`. State lives in the `webterm-home` volume (`CLAUDE_CONFIG_DIR=/home/webterm/.claude`), so it survives rebuilds. `docker compose down -v` deletes it.

## Project files: bind mount vs isolated volume

- **Default (bind mount):** `${WEBTERM_PROJECTS:-./workspace}` on the host is `/workspace`. Agents edit your real files. On Linux the folder must be writable by uid 1000 (`chown -R 1000 <dir>`) or set `user: "<your uid>:<your gid>"` in a compose override; the entrypoint stops with a message if it is not writable.
- **Isolated volume:** in a `docker-compose.override.yml` replace the mount with `- projects:/workspace` and declare `volumes: { projects: {} }`. Copy code in with `git clone` inside a webterm terminal. Nothing agents do can touch the host filesystem.

## Git and SSH

Never copy keys into the image. Pick one:

- **ssh-agent forwarding (Linux):** `- ${SSH_AUTH_SOCK}:/ssh-agent:ro` plus `SSH_AUTH_SOCK: /ssh-agent`. The socket must be readable by uid 1000. On Docker Desktop for macOS use `/run/host-services/ssh-auth.sock` as the source.
- **Read-only key mount:** `- ~/.ssh:/home/webterm/.ssh:ro` (use a dedicated deploy key, not your main key; agents running with bypass permissions can read whatever is mounted).
- **HTTPS:** run `git config --global credential.helper store` in a terminal, or use `gh auth login`; the whole home is the `webterm-home` volume, so this persists.

## Custom commands

Wrapper commands from your laptop (envman and friends) are often macOS binaries (Mach-O) and cannot run in the Linux container.

- **Works:** Linux binaries (match amd64/arm64), shell/Python/Node scripts, anything from apt, npm or pip.
- **Does not work:** macOS binaries, GUI tools, anything needing the Keychain.
- **Runtime, no rebuild:** `webterm command add|list|remove` (and the wizard) manage `WEBTERM_CUSTOM_BIN=/data/custom-bin`, a private (0700) directory on the data volume. It is first on PATH.
- **Static, read-only:** put files in `./custom-bin` (create it first, or Docker creates it as root) or set `WEBTERM_CUSTOM_BIN_HOST`; it is mounted at `/opt/custom/bin` and is second on PATH. Both directories are on PATH in login (`bash -l`), interactive and plain shells, and in agent sessions.
- **Bake in:** `docker/custom/Dockerfile.example` builds your own image on top of the published one.
- **Init hooks:** `/data/init.d/*.sh` run by name as the non-root user before the server (use them to `pip install --user`, copy files, ...). A failing hook logs its name and exit code and the server still starts, except for `*.required.sh`, which stops startup. Hook output is yours: do not print secrets in hooks. Hooks cannot change the server's env; use `env_file` for that.
- **Env for wrappers:** `WEBTERM_ENV_FILE=./wrappers.env` (compose `env_file`, default `/dev/null`). The entrypoint never prints the environment.
- **Verify:** run the webterm doctor, and `docker exec webterm which <cmd>` (add `-it ... bash -lc 'which <cmd>'` for the login-shell view).

## Installing your own tools

Run the same one-liner you use on your Mac (`curl -fsSL https://.../install | sh`) in a webterm terminal inside the container. The installer detects Linux and the CPU architecture itself, so the binary matches. The whole home (`/home/webterm`) is the `webterm-home` volume, so `~/.local`, `~/.cargo`, `~/.bun`, `~/go`, other `~/.<tool>` dirs, rc files and git config survive container recreation. `~/.local/bin`, `~/.bun/bin`, `~/.cargo/bin`, `~/go/bin`, `/data/custom-bin` and `/opt/custom/bin` are on PATH in login, interactive and plain shells.

- webterm refreshes its PATH resolver itself; run `webterm command rescan` if a tool is not found. A shell that was already open needs `exec $SHELL -l` when the installer only edited an rc file.
- The image has curl, wget, tar, gzip, bzip2, xz-utils, unzip, git, jq and ca-certificates, but no `sudo` and no compiler. Installers that need root fail: use their user-level mode, or derive an image (`docker/custom/Dockerfile.example`; add `build-essential` there if you compile from source).
- Warning: `curl | sh` runs with the container user's rights, not your host's, but it can still read everything mounted (workspace, keys, API key in env). Only run scripts from sources you trust.
- First start seeds `/etc/skel` into an empty home without overwriting existing files. `docker compose down -v` deletes the home volume.

## Limits

No Electrobun desktop shell and no macOS Keychain: the container serves the web UI only, and Claude login uses the file store in `webterm-home`. Dev servers and agent ports stay inside the container; webterm proxies them through its own port.

## Security model

The container is the safety boundary for agents running with bypass permissions. The compose file drops all capabilities, sets `no-new-privileges`, caps memory (`WEBTERM_MEM_LIMIT`, default 5g for an 8 GB machine), CPUs (`WEBTERM_CPUS`, default 4) and pids, and never uses `privileged` or `SYS_ADMIN`. Chrome runs with its own sandbox (never `--no-sandbox`); `docker/chrome.seccomp.json` allows the user-namespace syscalls it needs. Anything you mount (workspace, `~/.ssh`, the API key in env) is reachable by agents.

The seccomp profile is Docker's current default (`default.json` from `moby/profiles`, fetched 2026-11-19) with `clone`, `clone3`, `unshare` and `setns` allowed without `CAP_SYS_ADMIN`, and the default's `clone3 -> ENOSYS` and `clone` flag-mask rules removed. Chrome's sandbox then creates user namespaces. `chroot` is also allowed without `CAP_SYS_CHROOT` (the default only allows it with that capability, and `cap_drop: [ALL]` removes it): Chrome's namespace sandbox calls `chroot("/proc/self/fdinfo/")` inside its own user namespace, and without this entry seccomp kills it first (`sys_chroot("/proc/self/fdinfo/") == 0` check failure, zygote dies). The kernel still requires `CAP_SYS_CHROOT` in the namespace being chrooted, so this grants no new right in the container's own namespace. Found by a real test on arm64 (Colima, Docker 29); the other syscalls in Chrome's sandbox path were audited: `mount`, `umount2`, `sethostname` and friends stay gated by `CAP_SYS_ADMIN` and `pivot_root` is not allowed at all, because nothing showed Chrome needs them. An older community profile (jessfraz/dotfiles `chrome.json`, 2016) was rejected: it predates syscalls modern glibc uses. To refresh, rerun that derivation against the newest default profile.

The root filesystem is writable on purpose: agents install packages and write `~/.cache`, `~/.npm`, `~/.gitconfig`. A `read_only: true` variant is possible but untested; add tmpfs for each such path.

## Network

The server listens on `0.0.0.0:$PORT` inside the container (`HOST=0.0.0.0`) and is published as `127.0.0.1:$PORT` on the host. Auth is always on: access token plus account login. Outbound traffic is unrestricted; add an egress firewall if agents must be contained further.

## Troubleshooting

- **tmux/agent socket `EINVAL` or "path too long":** a socket path exceeded 104 bytes. The entrypoint sets `TMPDIR=/tmp/st`; do not override it with a long path.
- **Chrome crashes or tabs go blank:** `/dev/shm` too small. Compose sets `shm_size: 1gb`; with plain `docker run` pass `--shm-size=1g`.
- **`Check failed: sys_chroot("/proc/self/fdinfo/") == 0`, then the zygote dies:** an old copy of the seccomp profile (before `chroot` was allowed). Re-fetch `docker/chrome.seccomp.json` from the same tag as the image.
- **"No usable sandbox" / `clone: Operation not permitted`:** the seccomp profile is not applied (plain `docker run` needs `--security-opt seccomp=docker/chrome.seccomp.json`), the host has `kernel.unprivileged_userns_clone=0` or `user.max_user_namespaces=0`, or an AppArmor policy blocks user namespaces (Ubuntu 23.10+: `kernel.apparmor_restrict_unprivileged_userns=0`). Do not work around it with `--no-sandbox`.
- **`/workspace is not writable`:** fix host ownership, see above.
- **Unhealthy container:** `docker compose logs webterm`; the healthcheck accepts any HTTP answer from `/api/health`.

## Updating pinned versions

- **Claude Code:** `npm view @anthropic-ai/claude-code version`, then set `CLAUDE_CODE_VERSION` (env, or the `ARG` default in the Dockerfile and the default in `docker-compose.yml`) and `docker compose build`. Optional CLIs: `CODEX_VERSION` (`@openai/codex`), `GEMINI_CLI_VERSION` (`@google/gemini-cli`); empty means not installed.
- **Chrome (amd64):** the version and checksums are pinned in `scripts/fetch-chrome.ts`; bump them there, rebuild.
- **Chrome fetch dependencies:** `scripts/fetch-chrome.ts` runs before the app source is copied, so the Dockerfile copies the few `src/` files it imports (transitively) first, keeping the Chrome download layer cached. If you add an import there, add the file to those `COPY src/...` lines; `bun test scripts/fetchChrome.deps.bun.test.ts` fails until you do.
- **Chromium (arm64):** follows the Debian bookworm `chromium` package; rebuild with `--no-cache` (or bump the base image) to pick up Debian security updates.
- **Bun / Node:** `BUN_VERSION` and `NODE_VERSION` args at the top of the Dockerfile (keep Bun equal to `BUN_VERSION` in `.github/workflows/test.yml`).
