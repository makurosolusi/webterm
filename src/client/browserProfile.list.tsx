// Shared pieces for showing a browser profile: the live list hook (follows the server's `browserProfiles` frame),
// the colored dot, and the lookup of the profile a node really uses.
import type { CSSProperties } from 'react'
import { resolveProfileId } from '../shared/browser.profile'
import type { BrowserProfile } from '../shared/browser.profile'
import { workspaceColorVar } from '../shared/workspaceColor'
import { useBrowserProfiles } from './browserProfileApi'
import { subscribeBrowserProfiles } from './ws.listeners'

const subscribe = (cb: () => void): (() => void) => subscribeBrowserProfiles(() => cb())

/** Profile list for a board (`workspaceId`) or all of them; reloads on the server's profile frame. */
export const useProfileList = (workspaceId?: string): ReturnType<typeof useBrowserProfiles> => useBrowserProfiles({ workspaceId, subscribe })

/** The profile a node uses (its own id, else the board's Default), or undefined until the list knows it. */
export const profileOfNode = (profiles: readonly BrowserProfile[], workspaceId: string, profileId?: string): BrowserProfile | undefined => {
  const id = resolveProfileId(workspaceId, { profileId })
  return profiles.find((p) => p.id === id)
}

/** Round swatch in the profile's color (palette token, so it follows the theme). */
export function ProfileDot({ profile, className = '' }: { profile?: Pick<BrowserProfile, 'color' | 'shade'>; className?: string }): React.JSX.Element {
  const style: CSSProperties = { background: profile ? workspaceColorVar(profile.color, profile.shade) : 'var(--vscode-disabledForeground)' }
  return <span aria-hidden="true" data-profile-dot className={`inline-block size-2.5 shrink-0 rounded-full ${className}`} style={style} />
}
