// Developer mode: shows Settings › Developer (every raw value) in the sidebar. Off by default so the
// page of raw values does not sit next to everyday settings. Two ways in, both for maintainers:
// the "Show developer tools" switch at the bottom of Settings › Health, or `?dev=1` in the URL
// (`?dev=0` turns it off). Per browser (localStorage): troubleshooting one machine should not change
// what everyone else's Settings look like.
import { useSyncExternalStore } from 'react'

const KEY = 'webterm.developerMode'
const listeners = new Set<() => void>()

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false // storage blocked (private mode): developer mode simply stays off
  }
}

let cache: boolean | null = null

/** Developer mode on? `?dev=1` / `?dev=0` in the current URL wins and is remembered. */
export function readDeveloperMode(): boolean {
  if (cache !== null) return cache
  const dev = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('dev')
  if (dev === '1' || dev === '0') writeDeveloperMode(dev === '1')
  return (cache ??= stored())
}

export function writeDeveloperMode(on: boolean): void {
  cache = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch (err) {
    console.warn('developerMode: could not remember the choice; it holds for this tab only', err)
  }
  for (const l of listeners) l()
}

/** Forget the cached value (tests). */
export function resetDeveloperModeCache(): void {
  cache = null
}

/** React view of developer mode; re-renders on every change. */
export function useDeveloperMode(): boolean {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, readDeveloperMode)
}
