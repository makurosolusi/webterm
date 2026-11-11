// Semua teks UI kemampuan (Inggris, Rule 15). Tanpa nama env var dan tanpa istilah teknis internal.
import type { CapabilityId, CapabilityStatus } from '../shared/featureCapabilities'

export const CAPABILITY_STATUS_LABEL: Readonly<Record<CapabilityStatus, string>> = {
  on: 'On',
  off: 'Off',
  'needs-step': 'Needs one step',
}

export const CAPABILITY_TEXT = {
  alsoTurnsOn: 'Also turns on:',
  alsoTurnsOff: 'Also turns off:',
  offerQuestion: 'Turn it on now?',
  offerAction: 'Turn on',
  offerTitle: (title: string): string => `Turn on ${title}`,
  confirmTitle: (label: string): string => `Turn on ${label}?`,
  confirmBody: 'This gives agents more control over this computer and the accounts you are signed in to. Only turn it on if you trust the agents that run.',
  confirmCancel: 'Cancel',
  loadFailed: 'Could not load capabilities. Try again in a moment.',
  changeFailed: 'The change did not go through. Try again in a moment.',
  // 403 from the settings guard = no live UI session; a reload lands on the sign-in screen (appBoot).
  forbidden: 'Your session has ended. Reload to sign in again.',
} as const

/**
 * Kata kunci pencarian Settings per kartu (pola indeks pencarian Orca: title + description + keywords).
 * Kata yang diketik orang, bukan judul: "chrome", "cookie", "token", "localhost".
 */
export const CAPABILITY_KEYWORDS: Readonly<Record<CapabilityId | 'advanced' | 'token', readonly string[]>> = {
  central: ['agent', 'assistant', 'central', 'chat', 'ai'],
  workers: ['worker', 'orchestrator', 'command', 'run', 'approval'],
  autonomy: ['autonomy', 'automatic', 'unattended'],
  browser: ['browser', 'chrome', 'chromium', 'web', 'page', 'cookie', 'localhost', 'url', 'link'],
  files: ['file', 'folder', 'explorer'],
  filesWrite: ['file', 'upload', 'edit', 'delete', 'rename'],
  telegram: ['telegram', 'bot', 'token', 'chat', 'message'],
  token: ['token', 'access', 'security', 'tunnel', 'automation', 'script', 'mcp', 'api', 'remote'],
  advanced: ['advanced', 'chrome', 'chromium', 'location', 'engine', 'claude', 'data', 'reset'],
}

/** Daftar judul dipisah koma untuk baris "Also turns on/off". */
export const joinTitles = (titles: readonly string[]): string => titles.join(', ')
