// Teks bagian "Lanjutan" di tab Kemampuan (Rule 15). Tanpa nama env var dan tanpa istilah teknis internal.
import type { CapabilitiesResponse } from '../shared/featureCapabilities'

type Engine = CapabilitiesResponse['advanced']['agentEngine']['value']

export const ADVANCED_TEXT = {
  summary: 'Advanced',
  engineLabel: 'Central Agent engine',
  engineDetected: (name: string): string => `Detected: ${name}`,
  engineMissing: 'Not installed: install Claude Code, then check again.',
  engineChosenNotReady: (name: string): string => `${name} is not ready: it is not installed or not signed in.`,
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
  chromiumCandidates: 'Found on this computer',
  chromiumSave: 'Save location',
  chromiumUseAuto: 'Use automatic',
  chromiumRedetect: 'Detect again',
  dataDirLabel: 'Data folder',
  reset: 'Reset capabilities',
  resetHint: 'Restores capability choices to their defaults. Your data is not deleted.',
  changeFailed: 'The change did not go through. Try again in a moment.',
} as const

/** Picker label adds what the engine can do; `name` is the bare engine name used in status sentences. */
export const ENGINE_OPTIONS: ReadonlyArray<{ value: Engine; label: string; name: string }> = [
  { value: 'auto', label: 'Automatic', name: 'Automatic' },
  { value: 'claude', label: 'Claude', name: 'Claude' },
  { value: 'opencode', label: 'OpenCode (chat only)', name: 'OpenCode' },
]

/** Nama mesin hasil deteksi otomatis; `off` = tidak ada CLI yang ditemukan. */
export const engineName = (kind: string): string =>
  kind === 'off' ? 'none (install Claude Code)'
    : ENGINE_OPTIONS.find((o) => o.value === kind)?.name ?? kind

export const SECTION_TEXT = {
  loading: 'Loading capabilities…',
} as const
