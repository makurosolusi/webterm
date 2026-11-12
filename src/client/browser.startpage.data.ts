// Default start-page shortcuts (Chrome's NTP tiles). The user's own list lives in localStorage
// (`browser.shortcuts.ts`); this list seeds it until the user edits it. Search engines: `shared/browser.omnibox.ts`.

export interface Shortcut { id: string; label: string; url: string; /** Letter-fallback circle color; absent = neutral. */ color?: string }

/** Default tiles (order = display order). Color = background of the letter fallback while the favicon loads or fails. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'google', label: 'Google', url: 'https://www.google.com/', color: '#4285f4' },
  { id: 'youtube', label: 'YouTube', url: 'https://www.youtube.com/', color: '#ff0000' },
  { id: 'github', label: 'GitHub', url: 'https://github.com/', color: '#24292f' },
  { id: 'gmail', label: 'Gmail', url: 'https://mail.google.com/', color: '#ea4335' },
  { id: 'x', label: 'X', url: 'https://x.com/', color: '#000000' },
  { id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/', color: '#10a37f' },
  { id: 'reddit', label: 'Reddit', url: 'https://www.reddit.com/', color: '#ff4500' },
  { id: 'wikipedia', label: 'Wikipedia', url: 'https://www.wikipedia.org/', color: '#636466' },
]
