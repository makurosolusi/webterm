// Every string of the custom-commands panel (English, product language), shared by the wizard step and Settings.
import type { CustomCommandSource } from '../../shared/customCommands'

export const COMMANDS_TEXT = {
  title: 'Custom commands',
  /** One sentence for the surface hosting the panel (Settings row hint; the wizard's step description says the same). */
  intro: 'webterm finds tools you install on its own. Optional: add a folder they live in.',
  /** Markdown-style backticks become <code> (`CodeText`); never shown raw. */
  tip: 'In a terminal: `webterm command detect` rescans, `webterm command path add <folder>` adds a folder.',
  loading: 'Looking for tools on this machine…',
  loadFailed: 'Could not load the tools on this machine.',
  retry: 'Retry',
  retrying: 'Retrying…',
  found: {
    title: 'Found on this machine',
    empty: 'No helper tools found yet.',
    known: (n: number): string => `Known tools webterm looks for (${n})`,
    source: { 'custom-bin': 'webterm folder', extra: 'Tool folder', path: 'PATH', candidate: 'Known tool' } satisfies Record<CustomCommandSource, string>,
  },
  rescan: { button: 'Rescan', busy: 'Scanning…', failed: 'Rescan failed', result: (n: number): string => `${n} ${n === 1 ? 'directory' : 'directories'} added` },
  folders: {
    title: 'Tool folders',
    hint: 'Add a folder whose tools every terminal and agent should find. Only you should be able to write to it.',
    empty: 'No extra folders yet.',
    missing: 'Folder not found',
    unsafe: 'Unsafe: writable by other users',
    remove: 'Remove',
    removeBusy: 'Removing…',
    removeLabel: (dir: string): string => `Remove folder ${dir}`,
    removed: 'Folder removed',
    removeFailed: 'Could not remove the folder',
  },
  add: {
    label: 'Add a folder',
    hint: 'Pick a suggestion or type an absolute path, for example /home/you/.local/bin.',
    placeholder: '/path/to/tools',
    button: 'Add folder',
    busy: 'Adding…',
    needDir: 'Choose or type a folder first.',
    notAbsolute: 'Start the path with / (for example /home/you/.local/bin).',
    done: (dir: string): string => `Added ${dir}`,
    failed: 'Could not add the folder',
  },
  session: {
    title: 'Found this session',
    hint: 'These folders were added to PATH for this run only. Add them permanently to keep them after a restart.',
    button: 'Add permanently',
    buttonLabel: (dir: string): string => `Add ${dir} permanently`,
    busy: 'Adding…',
    done: 'Added permanently',
    failed: 'Could not add the folder',
  },
  compat: { wrong_platform: 'Wrong platform', wrong_arch: 'Wrong architecture' },
}
