// UI text of browser profiles (header chip + menu, spawn dialogs, Settings > Browser). One place so labels stay equal
// everywhere a profile shows. Server error codes map to plain sentences; unknown codes get the generic line.
import { BROWSER_PROFILE_NAME_MAX } from '../shared/browser.profile'
import type { BrowserProfile, ProfileErrorCode } from '../shared/browser.profile'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export const PROFILE_TEXT = {
  sharedSession: 'Nodes on the same profile share cookies and logins.',
  chipLabel: (name: string): string => `Browser profile: ${name}. Change profile`,
  chipTip: (name: string, nodes: number): string =>
    `Profile ${name}. ${nodes > 1 ? `${nodes} nodes share this session: ` : ''}Nodes on the same profile share cookies and logins.`,
  chipLoading: 'Profile',
  moving: 'Moving to profile…',
  menuLabel: 'Browser profiles',
  menuHeader: 'Switch profile',
  newProfile: 'New profile…',
  manage: 'Manage profiles…',
  retry: 'Retry',
  live: 'live',
  nodes: (n: number): string => plural(n, 'node', 'nodes'),
  rowHint: (p: Pick<BrowserProfile, 'live' | 'nodeCount'>): string =>
    [p.live ? 'live' : '', p.nodeCount > 0 ? plural(p.nodeCount, 'node', 'nodes') : ''].filter(Boolean).join(' · '),
  moved: (name: string): string => `Moved to profile ${name}; page reloaded`,
  moveFailed: (name: string, why: string): string => `Could not move to profile ${name}. ${why}`,
  listFailed: 'Profiles could not be loaded.',
  off: 'Browser is off',
  offHint: 'Turn the browser on under Features to create and manage profiles.',
  // spawn
  withProfile: 'Browser with profile…',
  forEach: 'Open a browser for each profile…',
  pickTitle: 'Open a browser with a profile',
  pickHint: 'The new browser starts signed in with that profile.',
  eachTitle: 'Open a browser for each profile',
  eachHint: 'One browser per profile, laid out in a grid. Each keeps its own logins.',
  selectAll: 'Select all',
  openN: (n: number): string => `Open ${plural(n, 'browser', 'browsers')}`,
  opening: 'Opening…',
  cancel: 'Cancel',
  noProfiles: 'No profiles yet. Create one to get started.',
  openedAll: (n: number): string => `Opened ${plural(n, 'browser', 'browsers')}.`,
  openedSome: (opened: number, total: number, max: number): string =>
    `Opened ${opened} of ${total}. The limit is ${max} active browsers; hide one to open the rest.`,
  openedNone: (max: number): string => `No browser opened. The limit is ${max} active browsers; hide one first.`,
  // create
  createTitle: 'New profile',
  createHint: 'A profile keeps its own cookies and logins. Browsers on different profiles never share a session.',
  nameLabel: 'Profile name',
  namePlaceholder: 'For example: Admin account',
  nameHelp: `Up to ${BROWSER_PROFILE_NAME_MAX} characters. Names are unique.`,
  create: 'Create profile',
  createAndSwitch: 'Create and switch',
  creating: 'Creating…',
  colorLabel: 'Profile color',
  hueLabel: 'Hue',
  shadeLabel: 'Shade',
  random: 'Random',
  autoColor: 'A color is picked for you. Change it if you like.',
  // settings
  sectionHint: 'Each profile is a separate login session. Open several browsers on different profiles to use several accounts at once.',
  groupTitle: 'Profiles',
  loading: 'Loading profiles…',
  isDefault: 'Default',
  usedBy: (n: number): string => `used by ${plural(n, 'node', 'nodes')}`,
  cookieDomains: (n: number): string => plural(n, 'cookie domain', 'cookie domains'),
  rename: 'Rename',
  save: 'Save',
  recolor: 'Color',
  importCookies: 'Import cookies…',
  duplicate: 'Duplicate',
  duplicateName: (name: string): string => `${name} copy`.slice(0, BROWSER_PROFILE_NAME_MAX),
  export: 'Export cookies',
  remove: 'Delete',
  rowMenu: (name: string): string => `Actions for profile ${name}`,
  duplicateLive: 'Close this profile’s browsers first: a running profile cannot be copied.',
  deleteInUse: (n: number): string => `${plural(n, 'node uses', 'nodes use')} this profile. Move them to another profile first.`,
  deleteDefault: 'The Default profile of a workspace cannot be deleted.',
  confirmDelete: (name: string): string => `Delete profile “${name}”?`,
  confirmDeleteBody: 'Its logins, cookies and browsing data are removed from this server. This cannot be undone.',
  deleted: (name: string): string => `Deleted profile ${name}.`,
  exported: (name: string): string => `Exported cookies of ${name}.`,
  working: 'Working…',
  errors: {
    profile_not_found: 'That profile no longer exists.',
    profile_name_taken: 'Another profile already has this name.',
    profile_name_invalid: `Enter a name of 1 to ${BROWSER_PROFILE_NAME_MAX} characters without control characters.`,
    profile_in_use: 'A browser node still uses this profile.',
    profile_live: 'This profile’s browser is running. Close its browsers first.',
    profile_default: 'The Default profile cannot be deleted.',
    bad_request: 'The server could not read that request.',
    cookie_import_disabled: 'Cookie import is turned off on this server.',
    cookie_import_invalid: 'That cookie file could not be read. Check its format.',
    cookie_import_empty: 'That file has no cookies that can be imported.',
  } satisfies Record<ProfileErrorCode, string>,
  generic: 'Something went wrong. Try again.',
  // cookies of one profile
  cookiesTitle: (name: string): string => `Cookies of ${name}`,
  cookiesDescription: (name: string): string => `Import cookies into the profile ${name} so its browsers stay signed in.`,
  googleSkipped: (n: number): string =>
    `Google sign-in cookies are not importable; sign in inside the profile (${plural(n, 'cookie', 'cookies')} skipped).`,
  skippedReason: (code: string): string => (code === 'google_source_bound'
    ? 'Google sign-in cookies are not importable; sign in inside the profile.'
    : `Skipped: ${code}.`),
  importSummary: (cookies: number, sites: number, skipped: number): string =>
    `Imported ${plural(cookies, 'cookie', 'cookies')} from ${plural(sites, 'site', 'sites')}${skipped > 0 ? `; skipped ${skipped}` : ''}.`,
} as const

/** Plain sentence for a thrown profile API error (its `code`), else the generic line. */
export function profileErrorText(e: unknown): string {
  const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : ''
  return (PROFILE_TEXT.errors as Record<string, string>)[code] ?? PROFILE_TEXT.generic
}
