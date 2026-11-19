// Non-React view of the `maskSecrets` setting for Monaco-side code (language-server peeks), which has no
// hook access. The editor nodes publish the live value; until one does, the schema default applies.
import { DEFAULT_SETTINGS } from '../shared/settings'
import { detectSecrets } from '../shared/secretMask.detect'
import { hiddenState, maskText } from './secretMask.reveal'

let on: boolean = DEFAULT_SETTINGS.maskSecrets

/** Called by the editor mask hook whenever the setting changes. */
export function publishMaskSetting(value: boolean): void {
  on = value
}

/** File text read from disk for display only (peek, rename preview): hidden while masking is on. */
export function maskDiskText(path: string, text: string): string {
  return on ? maskText(text, detectSecrets(path, text), hiddenState()) : text
}
