// Penjaga EL-04: default di registry (yang ditampilkan Settings) == default yang dipakai pembaca saat env kosong.
// readerDefault dihitung dengan MEMANGGIL pembaca nyata pada env kosong; `at` = lokasi pembaca. Kunci registry baru
// wajib masuk salah satu tabel di bawah, jadi default baru tak bisa menyimpang diam-diam.
import { describe, expect, it } from 'vitest'
import { lifecycleConfig } from './browser/browserLifecycle.service'
import { agentControlOn, cookieImportOn } from './browser/browser.runtime.parts'
import { captureLinksOn } from './linkCapture/linkCapture.config'
import { downloadModeOf } from './browser/browser.runtime.downloads'
import { accountsOn } from './browser/browser.runtime.accounts'
import { centralEnabled } from './central/centralModel'
import { autonomyEnabled } from './central/centralAutonomy'
import { maxInflightFromEnv, reliabilityEnabled } from './central/autonomyDispatch'
import { resolveLimits } from './central/chat/turnLimits'
import { checkpointOn } from './central/context/contextAssembler'
import { contextWindowTokens } from './central/context/rotationPolicy'
import { budgetLimits } from './central/guard/budgetStore'
import { envCeiling } from './central/guard/levelStore'
import { centralRuntimeKind } from './central/runtime/runtimeFlag'
import { approvalButtonsOn } from './channels/channelButtons'
import { telegramChannelEnabled } from './channels/channelsRuntime'
import { trustProxyEnabled } from './channels/webhookPeer'
import { agentSandboxOn } from './agentSandbox'
import { flagOn } from './envFlag'
import { ENV_REGISTRY, isBootstrapOnly, specFor } from './envRegistry'
import { FILES_FLAG, filesFlagOn, filesListMax, filesUploadMaxBytes, type FilesFlag } from './envRegistry.files'
import { parseCapacity } from './logs/logBus'
import { memoryFilesEnabled } from './memory/memoryFilePath'
import { orchestratorRunEnabled, orchestratorRunRequireApproval } from './orchestratorRunModel'
import { idleDoneMs } from './orchestrator/workerSignal'
import { setupEnv } from './envSettings.testutil'

const E: NodeJS.ProcessEnv = {}
const onOff = (b: boolean): string => (b ? 'on' : 'off')
const files = (name: FilesFlag) => (): string => onOff(filesFlagOn(name, E))
const budget = (k: 'tokens' | 'spawns' | 'costMicros') => (): string => String(budgetLimits(E)[k])

/** [kunci, pembaca nyata pada env kosong, lokasi pembaca]. */
const READERS: ReadonlyArray<readonly [string, () => string, string]> = [
  ['WEBTERM_TELEGRAM', () => onOff(telegramChannelEnabled(E)), 'channels/channelsRuntime.ts:94'],
  ['WEBTERM_CENTRAL_RUNTIME', () => centralRuntimeKind(''), 'central/runtime/runtimeFlag.ts:18'],
  ['WEBTERM_CENTRAL_AUTONOMY', () => onOff(autonomyEnabled('')), 'central/centralAutonomy.ts:99'],
  ['WEBTERM_CENTRAL_AGENTS', () => (envCeiling(E) === 'act_envelope' ? 'auto' : '?'), 'central/agentsMode.ts:9 (kosong = auto)'],
  ['WEBTERM_CENTRAL_TURN_STEPS', () => String(resolveLimits(E).maxTurns), 'central/chat/turnLimits.ts:27'],
  ['WEBTERM_CENTRAL_TURN_WALL_MS', () => String(resolveLimits(E).maxWallMs), 'central/chat/turnLimits.ts:28'],
  ['WEBTERM_CENTRAL_DAILY_TOKENS', budget('tokens'), 'central/guard/budgetStore.ts:29 (fallback = spec registry sendiri)'],
  ['WEBTERM_CENTRAL_DAILY_SPAWNS', budget('spawns'), 'central/guard/budgetStore.ts:29 (fallback = spec registry sendiri)'],
  ['WEBTERM_CENTRAL_DAILY_COST_MICROS', budget('costMicros'), 'central/guard/budgetStore.ts:29 (fallback = spec registry sendiri)'],
  ['WEBTERM_CENTRAL_MAX_INFLIGHT', () => String(maxInflightFromEnv('')), 'central/autonomyDispatch.ts:24'],
  ['WEBTERM_CENTRAL_CONTEXT_WINDOW', () => String(contextWindowTokens(E)), 'central/context/rotationPolicy.ts:15'],
  ['WEBTERM_AGENT_IDLE_DONE_MS', () => String(idleDoneMs(E)), 'orchestrator/workerSignal.ts:17'],
  ['WEBTERM_RUN_REQUIRE_APPROVAL', () => onOff(orchestratorRunRequireApproval(E)), 'orchestratorRunModel.ts:orchestratorRunRequireApproval'],
  ['WEBTERM_TRUST_PROXY', () => onOff(trustProxyEnabled(E)), 'channels/webhookPeer.ts:22'],
  ['WEBTERM_AGENT_SANDBOX', () => onOff(agentSandboxOn(E)), 'agentSandbox.ts:agentSandboxOn'],
  ['WEBTERM_LOG_BUFFER', () => String(parseCapacity(undefined)), 'logs/logBus.ts:12'],
  ['WEBTERM_BROWSER_MAX_LIVE', () => String(lifecycleConfig(E).maxLive), 'browser/browserLifecycle.service.ts:19'],
  // Default 'on' sejak impor cookie ikut menyala bersama browser (dulu FLAGON_READERS = off).
  ['WEBTERM_BROWSER_COOKIE_IMPORT', () => onOff(cookieImportOn(E)), 'browser/browser.runtime.parts.ts:cookieImportOn'],
  // Default 'on': webterm alat developer; agent yang tersambung kabel langsung bisa mengemudikan browser.
  ['WEBTERM_BROWSER_AGENT', () => onOff(agentControlOn(E)), 'browser/browser.runtime.parts.ts:agentControlOn'],
  // Default 'on': a link a terminal opens belongs to the canvas, so it lands in the canvas browser (docs/decisions/canvas-link-capture.md).
  // Default 'on': a finished download is kept in the webterm folder; off = Keep / Discard first (docs/decisions/browser-downloads.md).
  ['WEBTERM_BROWSER_DOWNLOADS_AUTO', () => onOff(downloadModeOf(E) === 'save'), 'browser/browser.runtime.downloads.ts:downloadModeOf'],
  // Default 'on': profiles show who is signed in (Google, GitHub), masked; off = no check and no data (docs/decisions/browser-profile-accounts.md).
  ['WEBTERM_BROWSER_ACCOUNTS', () => onOff(accountsOn(E)), 'browser/browser.runtime.accounts.ts:accountsOn'],
  ['WEBTERM_BROWSER_CAPTURE_LINKS', () => onOff(captureLinksOn(E)), 'linkCapture/linkCapture.config.ts:captureLinksOn'],
  // Default 'on' (F3-a zero-config): every inbox gate goes to Telegram with Approve once / Deny.
  ['WEBTERM_CHANNEL_APPROVAL_BUTTONS', () => onOff(approvalButtonsOn(E)), 'channels/channelButtons.ts:approvalButtonsOn'],
  // Default 'on' (zero-config): Central always knows the state of the work.
  ['WEBTERM_CENTRAL_CHECKPOINT', () => onOff(checkpointOn(E)), 'central/context/contextAssembler.ts:checkpointOn'],
  ['WEBTERM_BROWSER_DISCARD_MS', () => String(lifecycleConfig(E).discardMs), 'browser/browserLifecycle.service.ts:20'],
  ...(Object.entries(FILES_FLAG) as Array<[FilesFlag, string]>).map(([n, k]) => [k, files(n), 'envRegistry.files.ts:filesFlagOn'] as const),
  ['WEBTERM_FILES_LIST_MAX', () => String(filesListMax(E)), 'envRegistry.files.ts:filesListMax'],
  ['WEBTERM_FILES_UPLOAD_MAX_MB', () => String(filesUploadMaxBytes(E) / 1024 / 1024), 'envRegistry.files.ts:filesUploadMaxBytes'],
  // Pembaca inline (tak bisa dipanggil): default dikutip dari sumber.
  ['WEBTERM_LEDGER', () => 'off', 'ledger/ledgerRuntime.ts:ledgerMode (kunci lama TIDAK dibaca lagi: ledger selalu hidup, KE-1; nilai = default registry legacy)'],
  ['WEBTERM_LOG_LEVEL', () => 'info', 'logs/logger.ts:34 (`?? DEFAULT_LOG_LEVEL`)'],
  ['WEBTERM_LOG_FILE', () => 'on', "logs/logger.ts:108 (`?? 'on'`)"],
  ['WEBTERM_BROWSER_COOKIE_TTL_DAYS', () => '7', 'browser/browser.runtime.ts:68 (`ttl > 0 ? ttl : DEFAULT_COOKIE_TTL_DAYS`)'],
]

/** Pembaca `flagOn(env[KEY])`: env kosong = off. [kunci, lokasi]. */
const FLAGON_READERS: ReadonlyArray<readonly [string, string]> = [
  ['WEBTERM_BROWSER_HEADLESS', 'browser/chromium.flags.ts:headlessReason'],
]

/**
 * Default `on` (default maksimal, settings-overhaul W3) dengan pembaca fail-closed: envSettings.apply menulis `on` ke
 * env selama tak ada yang mengisinya (defaultOnOf), jadi pembaca melihat default yang sama. [kunci, pembaca(env), lokasi].
 */
const APPLIED_ON: ReadonlyArray<readonly [string, (env: NodeJS.ProcessEnv) => boolean, string]> = [
  ['WEBTERM_CENTRAL', (e) => centralEnabled(e.WEBTERM_CENTRAL ?? ''), 'central/centralModel.ts'],
  ['WEBTERM_CENTRAL_RELIABILITY', (e) => reliabilityEnabled(e.WEBTERM_CENTRAL_RELIABILITY ?? ''), 'central/autonomyDispatch.ts'],
  ['WEBTERM_ORCHESTRATOR_RUN', (e) => orchestratorRunEnabled(e), 'orchestratorRunModel.ts'],
  ['WEBTERM_MEMORY_FILES', (e) => memoryFilesEnabled(e), 'memory/memoryFilePath.ts'],
  ['WEBTERM_CENTRAL_MEMORY', (e) => flagOn(e.WEBTERM_CENTRAL_MEMORY), 'central/chat/turnService.ts'],
  ['WEBTERM_CENTRAL_SKILLS', (e) => flagOn(e.WEBTERM_CENTRAL_SKILLS), 'central/ca2Boot.ts'],
  ['WEBTERM_CENTRAL_SKILL_PROPOSE', (e) => flagOn(e.WEBTERM_CENTRAL_SKILL_PROPOSE), 'central/ca2Boot.ts'],
  ['WEBTERM_CENTRAL_BOTS', (e) => flagOn(e.WEBTERM_CENTRAL_BOTS), 'channels/botManager.ts'],
  ['WEBTERM_KNOWLEDGE', (e) => flagOn(e.WEBTERM_KNOWLEDGE), 'central/tools/registerAll.ts'],
  ['WEBTERM_AGENT_MAIL', (e) => flagOn(e.WEBTERM_AGENT_MAIL), 'central/tools/registerAll.ts'],
  ['WEBTERM_CENTRAL_READ_TOOLS', (e) => flagOn(e.WEBTERM_CENTRAL_READ_TOOLS), 'central/tools/defs/read.shared.ts'],
  ['WEBTERM_BROWSER', (e) => flagOn(e.WEBTERM_BROWSER), 'browser/browser.runtime.ts'],
]

/** Tanpa default statis: kosong = perilaku bawaan pembaca (secret, path, daftar, model, mode otomatis). */
const NO_STATIC_DEFAULT = [
  'WEBTERM_TELEGRAM_MODE', 'WEBTERM_TELEGRAM_BOT_TOKEN', 'WEBTERM_TELEGRAM_WEBHOOK_SECRET', 'WEBTERM_CENTRAL_MODEL',
  'WEBTERM_MEMORY_DIR', 'WEBTERM_CONTROL_CWD_ROOTS', 'WEBTERM_BROWSER_BIN', 'WEBTERM_BROWSER_ALLOW_HOSTS',
]

describe('default registry == default pembaca (env kosong)', () => {
  it.each(READERS)('%s', (key, reader, at) => {
    expect(specFor(key)?.default, `${key} (pembaca ${at})`).toBe(reader())
  })

  it.each(FLAGON_READERS)('%s: flagOn(kosong) = off', (key, at) => {
    expect(flagOn(undefined)).toBe(false)
    expect(specFor(key)?.default, `${key} (pembaca ${at})`).toBe('off')
  })

  it.each(APPLIED_ON)('%s: default on, ditulis ke env oleh envSettings.apply', (key, reader, at) => {
    expect(specFor(key)?.default, key).toBe('on')
    expect(reader({}), `${key} (pembaca ${at}) fail-closed tanpa apply`).toBe(false)
    expect(reader(setupEnv().target), `${key} (pembaca ${at}) setelah apply`).toBe(true)
  })

  it('kunci tanpa default statis memang tak punya default (atau kosong)', () => {
    for (const key of NO_STATIC_DEFAULT) expect(specFor(key)?.default ?? '', key).toBe('')
  })

  it('setiap kunci registry non-bootstrap tercakup tepat satu tabel (kunci baru wajib menyatakan default pembacanya)', () => {
    const covered = [...READERS.map(([k]) => k), ...FLAGON_READERS.map(([k]) => k), ...APPLIED_ON.map(([k]) => k), ...NO_STATIC_DEFAULT]
    const missing = ENV_REGISTRY.map((s) => s.key).filter((k) => !isBootstrapOnly(k) && !covered.includes(k))
    expect(missing).toEqual([])
    expect(covered.filter((k, i) => covered.indexOf(k) !== i)).toEqual([])
    expect(covered.filter((k) => !specFor(k))).toEqual([])
  })
})
