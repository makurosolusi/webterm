// Seluruh teks kartu "Token akses" (Rule 15). Tanpa nama env var; sumber "env" disebut dengan kata biasa.

export const TOKEN_TEXT = {
  title: 'Access token',
  loading: 'Checking access token...',
  loadFailed: 'Could not load the access token status. Try again in a moment.',
  off: 'Off. Anyone on this computer can open webterm via 127.0.0.1 without a token.',
  onFile: 'On. Every browser must open webterm through a link that contains the token.',
  onEnv: 'On, set outside webterm (an environment variable when the server was started). To change or turn it off, edit how that server is launched.',
  why: 'Turn this on if webterm is opened from another device or through a tunnel, so only people with the link can get in.',
  offRemote: 'The token can only be turned on from a page opened directly on this computer (127.0.0.1).',
  enable: 'Enable token',
  rotate: 'Rotate token',
  confirmEnable:
    'Enable the access token?\n\nThe link with the token is shown only ONCE. Copy it now. Other open webterm tabs must be reopened with that link.',
  confirmRotate:
    'Rotate the access token?\n\nThe old token stops working immediately. The new link is shown only ONCE. Other devices and tabs must be reopened with the new link.',
  linkIntro: 'This link is shown only once. Copy it now and keep it somewhere safe.',
  linkLabel: 'Link with token',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Could not copy. Select the link text and copy it manually.',
  reloadHint: 'This tab is already signed in with the new token and will reload when you press Done or close Settings.',
  signInFailed: 'The token changed, but this tab could not sign in with it. Copy the link above and open it to sign in again.',
  done: 'Done',
  // Kode 403/409/500 dari tokenAccess.api.ts -> kalimat jujur (sebab + jalan keluar).
  agentCannot: 'Denied: the access token can only be changed from a webterm window, not from an agent session.',
  browserOnly: 'Denied: the access token can only be changed from the webterm page in a browser.',
  loopbackOnly: 'Denied: the token can only be turned on from a page opened directly on this computer (127.0.0.1).',
  changed: 'The token status changed elsewhere. The latest status has been loaded.',
  failed: 'The change did not go through. Try again in a moment.',
} as const
