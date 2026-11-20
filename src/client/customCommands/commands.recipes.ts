// Recipes: one-click commands typed (never run) into the setup terminal. Pure data; every command was checked
// against the tool's official docs on 2026-11-20 (URLs below). User-space installers only: the server often
// runs in a container without sudo or apt, so nothing here may need root.
//
// Not included on purpose: GitHub CLI install (not in the Docker image; apt is unavailable and a per-arch
// release download could not be verified here).

export interface CommandRecipe {
  id: string
  label: string
  /** Typed into the terminal WITHOUT Enter; the user reads it and presses Enter. */
  command: string
  /** One line: what it does (shown with the command). */
  description: string
  /** Hide the chip once this binary is detected (the tool is already installed). */
  hideWhenFound?: string
  /** Show the chip only while this binary is detected (a login step needs the tool). */
  showWhenFound?: string
}

export const COMMAND_RECIPES: readonly CommandRecipe[] = [
  {
    id: 'bun',
    label: 'Install Bun',
    // Source: https://bun.sh/docs/installation (installs to ~/.bun/bin)
    command: 'curl -fsSL https://bun.com/install | bash',
    description: 'JavaScript runtime and package manager.',
    hideWhenFound: 'bun',
  },
  {
    id: 'node',
    label: 'Install Node.js (LTS)',
    // Sources: https://github.com/Schniz/fnm (installer, --skip-shell, default dir ~/.local/share/fnm),
    // https://raw.githubusercontent.com/Schniz/fnm/master/docs/commands.md (`fnm env`, `fnm install --lts`)
    command: 'curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell && export PATH="$HOME/.local/share/fnm:$PATH" && eval "$(fnm env --shell bash)" && fnm install --lts',
    description: 'Installs fnm, then the latest LTS Node.js.',
    hideWhenFound: 'node',
  },
  {
    id: 'python',
    label: 'Install Python (uv)',
    // Source: https://docs.astral.sh/uv/getting-started/installation/ (standalone installer, installs to ~/.local/bin)
    command: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
    description: 'Installs uv, which also installs and runs Python.',
    hideWhenFound: 'uv',
  },
  {
    id: 'gh-login',
    label: 'Sign in to GitHub',
    // Source: https://cli.github.com/manual/gh_auth_login (interactive; browser or device code)
    command: 'gh auth login',
    description: 'Signs the GitHub CLI in to your account.',
    showWhenFound: 'gh',
  },
  {
    id: 'claude-login',
    label: 'Sign in to Claude',
    // Source: `claude auth login --help` (Claude Code CLI, subscription by default); https://code.claude.com/docs/en/cli-reference
    command: 'claude auth login',
    description: 'Signs Claude Code in to your Claude account.',
    showWhenFound: 'claude',
  },
]

/** Recipes worth showing given the names of the tools found on this machine. */
export function visibleRecipes(found: ReadonlySet<string>, recipes: readonly CommandRecipe[] = COMMAND_RECIPES): CommandRecipe[] {
  return recipes.filter((r) => !(r.hideWhenFound && found.has(r.hideWhenFound)) && !(r.showWhenFound && !found.has(r.showWhenFound)))
}
