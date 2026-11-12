// Every sentence of the "Automation token" card (Rule 15). No env var names; the "env" source is described in plain words.
// The token is for machines (scripts, MCP clients, agents); people sign in with their account.

export const TOKEN_TEXT = {
  title: 'Automation token',
  loading: 'Checking the automation token...',
  loadFailed: 'Could not load the automation token status. Try again in a moment.',
  intro: 'For scripts, MCP clients and agents that call webterm. People sign in with their account (Settings › Account), not with this token.',
  off: 'Off. Programs on other machines cannot call webterm with a token.',
  onFile: 'On. Scripts and agents send this token with every request.',
  onEnv: 'On, set outside webterm (an environment variable when the server was started). To change or turn it off, edit how that server is launched.',
  why: 'Turn this on to let scripts, MCP clients or agents on another device or through a tunnel call webterm.',
  offRemote: 'The token can only be turned on from a page opened directly on this computer (127.0.0.1).',
  enable: 'Enable token',
  rotate: 'Rotate token',
  enabling: 'Enabling…',
  rotating: 'Rotating…',
  shownBelow: 'New token below. Copy it now.',
  unchanged: 'Not changed.',
  confirmEnable:
    'Enable the automation token?\n\nThe token is shown only ONCE. Copy it now. Other signed-in browsers will be signed out.',
  confirmRotate:
    'Rotate the automation token?\n\nThe old token stops working immediately; scripts and agents need the new one. It is shown only ONCE. Other signed-in browsers will be signed out.',
  valueIntro: 'This token is shown only once. Copy it now and keep it somewhere safe.',
  valueLabel: 'Automation token value',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Could not copy. Select the token text and copy it manually.',
  done: 'Done',
  // Kode 403/409/500 dari tokenAccess.api.ts -> kalimat jujur (sebab + jalan keluar).
  agentCannot: 'Denied: the automation token can only be changed from a webterm window, not from an agent session.',
  browserOnly: 'Denied: the automation token can only be changed from the webterm page in a browser.',
  loopbackOnly: 'Denied: the token can only be turned on from a page opened directly on this computer (127.0.0.1).',
  changed: 'The token status changed elsewhere. The latest status has been loaded.',
  failed: 'The change did not go through. Try again in a moment.',
} as const
