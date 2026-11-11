// Teks bagian "Lanjutan" di tab Kemampuan (Rule 15). Tanpa nama env var dan tanpa istilah teknis internal.
import type { CapabilitiesResponse } from '../shared/featureCapabilities'

type Engine = CapabilitiesResponse['advanced']['agentEngine']['value']

export const ADVANCED_TEXT = {
  summary: 'Advanced',
  engineLabel: 'Central Agent engine',
  engineDetected: (name: string): string => `Detected: ${name}`,
  engineMissing: 'Set up Claude: add or pick a profile in Settings › Agent › Claude launch profiles, press Test, then check again.',
  engineRecheck: 'Check again',
  engineChecking: 'Checking…',
  engineRecheckHint: 'Re-detect installed agent engines',
  chromiumLabel: 'Chromium location',
  chromiumPlaceholder: 'Path to the Chromium app',
  chromiumAuto: (path: string): string => `Automatic: ${path}`,
  chromiumUsingAuto: 'In use (automatic):',
  chromiumUsingOverride: 'In use (your choice):',
  chromiumOverrideInvalid: 'The location you chose was not found, so the browser can’t run. Fix it or use automatic.',
  chromiumMissing: 'Chromium was not found. Enter its location here.',
  chromiumUseAuto: 'Use automatic',
  chromiumRedetect: 'Detect again',
  dataDirLabel: 'Data folder',
  reset: 'Reset capabilities',
  resetHint: 'Restores capability choices to their defaults. Your data is not deleted.',
  changeFailed: 'The change did not go through. Try again in a moment.',
} as const

/** "Download Chromium" (wizard Browser step and Settings › Capabilities › Advanced). */
export const DOWNLOAD_TEXT = {
  start: 'Download Chromium (~200 MB)',
  hint: 'Chrome for Testing from Google, saved in the webterm data folder. Nothing else on this computer changes.',
  checking: 'Checking the download…',
  progress: (percent: number): string => (percent > 0 ? `Downloading Chromium… ${percent}%` : 'Downloading Chromium…'),
  progressLabel: 'Chromium download',
  cancel: 'Cancel',
  retry: 'Retry',
  done: 'Chromium is downloaded and in use:',
  unreachable: 'Could not reach the webterm server. Try again.',
} as const

/** Picker label adds what the engine can do; `name` is the bare engine name used in status sentences. */
export const ENGINE_OPTIONS: ReadonlyArray<{ value: Engine; label: string; name: string }> = [
  { value: 'auto', label: 'Automatic', name: 'Automatic' },
  { value: 'claude', label: 'Claude', name: 'Claude' },
]

/** Nama mesin hasil deteksi otomatis; `off` = tidak ada CLI yang ditemukan. */
export const engineName = (kind: string): string =>
  kind === 'off' ? 'none (set up Claude)'
    : ENGINE_OPTIONS.find((o) => o.value === kind)?.name ?? kind

export const SECTION_TEXT = {
  loading: 'Loading capabilities…',
} as const
