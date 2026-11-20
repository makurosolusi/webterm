// Every sentence of the New project / Clone repository dialogs and the Start screen's empty-workspace form.

export const CREATE_TEXT = {
  newProject: {
    title: 'New project',
    description: 'Creates an empty folder and opens it as a workspace.',
    nameLabel: 'Project name',
    namePlaceholder: 'my-project',
    submit: 'Create project',
    submitting: 'Creating…',
    needName: 'Enter a project name first.',
    needParent: 'Choose a parent folder first.',
    fixName: 'Fix the project name first.',
  },
  parent: { label: 'Parent folder', placeholder: '/path/to/projects', browse: 'Browse…' },
  git: {
    label: 'Initialize git repository',
    description: 'Adds an initial commit so worktrees work.',
  },
  hint: { prefix: 'Will be created at' },
  cancel: 'Cancel',
  /** Shown after a project was created with the fallback author (git had no identity). */
  bootstrapIdentity: 'First commit is authored as webterm. Set your git name and email in a terminal to use your own.',
  clone: {
    title: 'Clone repository',
    submit: 'Clone',
    submitting: 'Cloning…',
  },
  name: {
    empty: 'Enter a project name.',
    dots: 'A name cannot be "." or "..".',
    slash: 'A name cannot contain slashes.',
    control: 'A name cannot contain control characters.',
    long: 'A name can be at most 255 characters.',
  },
  created: {
    opened: 'Opened as a workspace:',
    reveal: 'Reveal in Finder',
    copy: 'Copy path',
    copied: 'Path copied.',
    copyFailed: 'Could not copy the path.',
    done: 'Done',
  },
  loadFailed: 'Could not load the default folder.',
} as const

export const WELCOME_TEXT = {
  title: 'webterm',
  tagline: 'A canvas of terminals. Start a project to begin.',
  start: 'Start',
  newProject: 'New project',
  openFolder: 'Open folder…',
  cloneRepo: 'Clone repo…',
  recent: 'Recently closed',
  empty: {
    label: 'Or create an empty workspace',
    placeholder: 'workspace name',
    submit: 'Create empty',
    needName: 'Enter a workspace name.',
  },
} as const
