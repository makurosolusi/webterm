# syntax=docker/dockerfile:1
# webterm container image: Bun server + built UI, tmux, git, Node (for agent CLIs), pinned Claude Code,
# pinned Chrome for Testing. No credentials are ever baked in; see docs/docker.md.
# Versions verified 2026-11-19: oven/bun 1.4.2-debian (matches BUN_VERSION in the CI workflow),
# node 24 (LTS) bookworm-slim, @anthropic-ai/claude-code 2.1.328.
ARG BUN_VERSION=1.4.2
ARG NODE_VERSION=24

FROM oven/bun:${BUN_VERSION}-debian AS bun

# ---- build: dependencies + client bundle -------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-debian AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run vite build

# ---- runtime ----------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG CLAUDE_CODE_VERSION=2.1.328
# Optional extra agent CLIs: pass e.g. --build-arg CODEX_VERSION=0.170.0 (empty = not installed).
ARG CODEX_VERSION=
ARG GEMINI_CLI_VERSION=

# Chrome runtime libraries: Debian list from Puppeteer's troubleshooting guide (pptr.dev/troubleshooting),
# with bookworm names (libgcc-s1 replaces libgcc1). fonts-noto* cover CJK, emoji and Latin rendering.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini tmux git openssh-client ca-certificates curl wget procps \
      tar gzip bzip2 xz-utils unzip jq \
      fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 \
      libfontconfig1 libgbm1 libgcc-s1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
      libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
      libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# Agent CLIs, versions locked (bump the ARGs deliberately; see docs/docker.md).
RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    ${CODEX_VERSION:+"@openai/codex@${CODEX_VERSION}"} \
    ${GEMINI_CLI_VERSION:+"@google/gemini-cli@${GEMINI_CLI_VERSION}"} \
    && npm cache clean --force

# No sudo on purpose: installers that need root fail; use user-level installs or a derived image.
# Custom commands: managed dir (/data/custom-bin, writable, persisted) first, then the static read-only mount.
# Debian's /etc/profile resets PATH for login shells, so the same prefix is re-applied from a shared snippet
# sourced by /etc/profile.d (login shells) and by the skeleton ~/.bashrc / ~/.zshenv (interactive shells).
# The server merges the login shell PATH after its own, so these entries keep priority everywhere.
RUN mkdir -p /opt/custom/bin /usr/local/share/webterm \
    && printf '%s\n' \
      'case ":$PATH:" in *":/data/custom-bin:"*) ;; *) PATH="/data/custom-bin:/opt/custom/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/go/bin:$PATH" ;; esac' \
      'export PATH' > /usr/local/share/webterm/path.sh \
    && ln -s /usr/local/share/webterm/path.sh /etc/profile.d/webterm-path.sh \
    && echo '. /usr/local/share/webterm/path.sh' >> /etc/skel/.bashrc \
    && echo '. /usr/local/share/webterm/path.sh' >> /etc/skel/.zshenv

# The base image ships user `node` as uid 1000; replace it with `webterm` (same uid).
RUN userdel -r node \
    && useradd --uid 1000 --create-home --shell /bin/bash webterm \
    && mkdir -p /data /workspace /app /opt/chrome \
    && chown webterm:webterm /data /workspace /app

WORKDIR /app

# Browser, per architecture. Chromium always runs with its sandbox: never --no-sandbox (see
# docker/chrome.seccomp.json and docs/docker.md). Both paths end in /usr/local/bin/chrome.
#  - amd64: Chrome for Testing, pinned + checksummed by scripts/fetch-chrome.ts (prints the binary path).
#    Own layer before the app code so source edits do not re-download it; the script needs no src/.
#  - arm64: Chrome for Testing has no linux arm64 build, so use Debian bookworm's `chromium` package
#    (156.x on 2026-11-19, security-updated; version follows Debian, NOT pinned by us).
# NOTE: scripts/fetch-chrome.ts is added by the chrome-binary change; the amd64 build needs it merged.
ARG TARGETARCH
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY scripts ./scripts
RUN set -eu; \
    if [ "${TARGETARCH:-amd64}" != "arm64" ]; then \
      CHROME_BIN="$(bun scripts/fetch-chrome.ts --dest /opt/chrome | tail -n 1)"; \
      chmod -R a+rX /opt/chrome; \
    else \
      apt-get update && apt-get install -y --no-install-recommends chromium; \
      rm -rf /var/lib/apt/lists/*; \
      CHROME_BIN=/usr/bin/chromium; \
    fi; \
    test -x "$CHROME_BIN"; \
    ln -s "$CHROME_BIN" /usr/local/bin/chrome; \
    /usr/local/bin/chrome --version
ENV WEBTERM_BROWSER_BIN=/usr/local/bin/chrome

COPY --from=build --chown=webterm:webterm /app/src ./src
COPY --from=build --chown=webterm:webterm /app/dist ./dist
COPY --from=build --chown=webterm:webterm /app/tsconfig.json /app/vite.config.ts /app/bunfig.toml ./
COPY docker/entrypoint.sh /usr/local/bin/webterm-entrypoint
COPY docker/seed-home.sh /usr/local/share/webterm/seed-home.sh
RUN chmod 0755 /usr/local/bin/webterm-entrypoint

USER webterm
ENV NODE_ENV=production \
    HOME=/home/webterm \
    PORT=8700 \
    HOST=0.0.0.0 \
    WEBTERM_DATA_DIR=/data \
    WEBTERM_CUSTOM_BIN=/data/custom-bin \
    PATH=/data/custom-bin:/opt/custom/bin:/home/webterm/.local/bin:/home/webterm/.bun/bin:/home/webterm/.cargo/bin:/home/webterm/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    CLAUDE_CONFIG_DIR=/home/webterm/.claude \
    TMPDIR=/tmp/st
VOLUME ["/data", "/workspace"]
WORKDIR /workspace
EXPOSE 8700

# -s: act as subreaper so tini also reaps zombies when Docker's own init (`init: true`) is PID 1.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/webterm-entrypoint"]
CMD ["bun", "/app/src/server/index.ts"]
