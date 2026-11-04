// Penjaga EL-04: default di registry (yang ditampilkan Settings) == default yang dipakai pembaca saat env kosong.
// readerDefault dihitung dengan MEMANGGIL pembaca nyata pada env kosong; `at` = lokasi pembaca. Kunci registry baru
// wajib masuk salah satu tabel di bawah, jadi default baru tak bisa menyimpang diam-diam.
import { describe, expect, it } from 'vitest'
import { lifecycleConfig } from './browser/browserLifecycle.service'
import { agentControlOn, cookieImportOn } from './browser/browser.runtime.parts'
import { centralEnabled } from './central/centralModel'
import { autonomyEnabled } from './central/centralAutonomy'
import { maxInflightFromEnv, reliabilityEnabled } from './central/autonomyDispatch'
import { resolveLimits } from './central/chat/turnLimits'
import { contextWindowTokens } from './central/context/rotationPolicy'
import { budgetLimits } from './central/guard/budgetStore'
import { envCeiling } from './central/guard/levelStore'
import { centralRuntimeKind } from './central/runtime/runtimeFlag'
import { opencodeBin, opencodeToolsAllowed } from './central/runtime/opencodeOptions'
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

const E: NodeJS.ProcessEnv = {}
const onOff = (b: boolean): string => (b ? 'on' : 'off')
const files = (name: FilesFlag) => (): string => onOff(filesFlagOn(name, E))
const budget = (k: 'tokens' | 'spawns' | 'costMicros') => (): string => String(budgetLimits(E)[k])

/** [kunci, pembaca nyata pada env kosong, lokasi pembaca]. */
const READERS: ReadonlyArray<readonly [string, () => string, string]> = [
  ['WEBTERM_CHANNELS', () => 'on', 'channels/channelsMasterGate.ts (kunci TIDAK dibaca lagi: kanal ikut kemampuan telegram; nilai = default registry legacy)'],
  ['WEBTERM_TELEGRAM', () => onOff(telegramChannelEnabled(E)), 'channels/channelsRuntime.ts:94'],
  ['WEBTERM_CENTRAL', () => onOff(centralEnabled('')), 'central/centralModel.ts:67'],
  ['WEBTERM_CENTRAL_RUNTIME', () => centralRuntimeKind(''), 'central/runtime/runtimeFlag.ts:18'],
  ['WEBTERM_CENTRAL_AUTONOMY', () => onOff(autonomyEnabled('')), 'central/centralAutonomy.ts:99'],
  ['WEBTERM_CENTRAL_RELIABILITY', () => onOff(reliabilityEnabled('')), 'central/autonomyDispatch.ts:12'],
  ['WEBTERM_CENTRAL_AGENTS', () => (envCeiling(E) === 'propose' ? 'off' : '?'), 'central/guard/levelStore.ts:37 (off = hanya propose)'],
  ['WEBTERM_OPENCODE_BIN', () => opencodeBin(''), 'central/runtime/opencodeOptions.ts:61'],
  ['WEBTERM_OPENCODE_ALLOW_TOOLS', () => onOff(opencodeToolsAllowed('')), 'central/runtime/opencodeOptions.ts:66'],
  ['WEBTERM_CENTRAL_TURN_STEPS', () => String(resolveLimits(E).maxTurns), 'central/chat/turnLimits.ts:27'],
  ['WEBTERM_CENTRAL_TURN_WALL_MS', () => String(resolveLimits(E).maxWallMs), 'central/chat/turnLimits.ts:28'],
  ['WEBTERM_CENTRAL_TURN_TOKENS', () => String(resolveLimits(E).maxTokens), 'central/chat/turnLimits.ts:29'],
  ['WEBTERM_CENTRAL_DAILY_TOKENS', budget('tokens'), 'central/guard/budgetStore.ts:29 (fallback = spec registry sendiri)'],
  ['WEBTERM_CENTRAL_DAILY_SPAWNS', budget('spawns'), 'central/guard/budgetStore.ts:29 (fallback = spec registry sendiri)'],
  ['WEBTERM_CENTRAL_DAILY_COST_MICROS', budget('costMicros'), 'central/guard/budgetStore.ts:29 (fallback = spec registry sendiri)'],
  ['WEBTERM_CENTRAL_MAX_INFLIGHT', () => String(maxInflightFromEnv('')), 'central/autonomyDispatch.ts:24'],
  ['WEBTERM_CENTRAL_CONTEXT_WINDOW', () => String(contextWindowTokens(E)), 'central/context/rotationPolicy.ts:15'],
  ['WEBTERM_AGENT_IDLE_DONE_MS', () => String(idleDoneMs(E)), 'orchestrator/workerSignal.ts:17'],
  ['WEBTERM_ORCHESTRATOR_RUN', () => onOff(orchestratorRunEnabled(E)), 'orchestratorRunModel.ts:36'],
  ['WEBTERM_RUN_REQUIRE_APPROVAL', () => onOff(orchestratorRunRequireApproval(E)), 'orchestratorRunModel.ts:42'],
  ['WEBTERM_MEMORY_FILES', () => onOff(memoryFilesEnabled(E)), 'memory/memoryFilePath.ts:23'],
  ['WEBTERM_TRUST_PROXY', () => onOff(trustProxyEnabled(E)), 'channels/webhookPeer.ts:22'],
  ['WEBTERM_AGENT_SANDBOX', () => onOff(agentSandboxOn(E)), 'agentSandbox.ts:agentSandboxOn'],
  ['WEBTERM_LOG_BUFFER', () => String(parseCapacity(undefined)), 'logs/logBus.ts:12'],
  ['WEBTERM_BROWSER_MAX_LIVE', () => String(lifecycleConfig(E).maxLive), 'browser/browserLifecycle.service.ts:19'],
  // Default 'on' sejak impor cookie ikut menyala bersama browser (dulu FLAGON_READERS = off).
  ['WEBTERM_BROWSER_COOKIE_IMPORT', () => onOff(cookieImportOn(E)), 'browser/browser.runtime.parts.ts:cookieImportOn'],
  // Default 'on': webterm alat developer; agent yang tersambung kabel langsung bisa mengemudikan browser.
  ['WEBTERM_BROWSER_AGENT', () => onOff(agentControlOn(E)), 'browser/browser.runtime.parts.ts:agentControlOn'],
  // Default 'on' (F3-a zero-config): every inbox gate goes to Telegram with Approve once / Deny.
  ['WEBTERM_CHANNEL_APPROVAL_BUTTONS', () => onOff(approvalButtonsOn(E)), 'channels/channelButtons.ts:approvalButtonsOn'],
  ['WEBTERM_BROWSER_DISCARD_MS', () => String(lifecycleConfig(E).discardMs), 'browser/browserLifecycle.service.ts:20'],
  ...(Object.entries(FILES_FLAG) as Array<[FilesFlag, string]>).map(([n, k]) => [k, files(n), 'envRegistry.files.ts:filesFlagOn'] as const),
  ['WEBTERM_FILES_LIST_MAX', () => String(filesListMax(E)), 'envRegistry.files.ts:filesListMax'],
  ['WEBTERM_FILES_UPLOAD_MAX_MB', () => String(filesUploadMaxBytes(E) / 1024 / 1024), 'envRegistry.files.ts:filesUploadMaxBytes'],
  // Pembaca inline (tak bisa dipanggil): default dikutip dari sumber.
  ['WEBTERM_LEDGER', () => 'off', 'ledger/ledgerRuntime.ts:ledgerMode (kunci lama TIDAK dibaca lagi: ledger selalu hidup, KE-1; nilai = default registry legacy)'],
  ['WEBTERM_LOG_LEVEL', () => 'info', 'logs/logger.ts:34 (`?? DEFAULT_LOG_LEVEL`)'],
  ['WEBTERM_LOG_FILE', () => 'on', "logs/logger.ts:108 (`?? 'on'`)"],
  ['WEBTERM_CENTRAL_TOOLS', () => 'read', 'shared/featureCapabilities.ts (linked by the Worker orchestrator card; no Central chat reader since K7)'],
  ['WEBTERM_BROWSER_COOKIE_TTL_DAYS', () => '7', 'browser/browser.runtime.ts:68 (`ttl > 0 ? ttl : DEFAULT_COOKIE_TTL_DAYS`)'],
]

/** Pembaca `flagOn(env[KEY])`: env kosong = off. [kunci, lokasi]. */
const FLAGON_READERS: ReadonlyArray<readonly [string, string]> = [
  ['WEBTERM_CENTRAL_TELEGRAM', 'channels/telegramCentralBridge.ts:16'],
  ['WEBTERM_CENTRAL_CHAT', 'centralChatApi.ts:49'],
  ['WEBTERM_CENTRAL_PLANNER', 'shared/featureCapabilities.ts (linked by the Worker orchestrator card; no Central chat reader since K7)'],
  ['WEBTERM_CENTRAL_MEMORY', 'central/chat/turnService.ts:123'],
  ['WEBTERM_CENTRAL_CHECKPOINT', 'central/context/contextAssembler.ts:87'],
  ['WEBTERM_CENTRAL_SKILLS', 'central/ca2Boot.ts:132'],
  ['WEBTERM_CENTRAL_SKILL_PROPOSE', 'central/ca2Boot.ts:132'],
  ['WEBTERM_CENTRAL_BOTS', 'channels/botManager.ts:120'],
  ['WEBTERM_KNOWLEDGE', 'central/tools/registerAll.ts:51'],
  ['WEBTERM_AGENT_MAIL', 'central/tools/registerAll.ts:50'],
  ['WEBTERM_CENTRAL_READ_TOOLS', 'central/tools/defs/read.shared.ts:READ_TOOLS_FLAG (def.flag, toolTypes defEnabled)'],
  ['WEBTERM_BROWSER', 'browser/browser.runtime.ts:53'],
  ['WEBTERM_BROWSER_HEADLESS', 'browser/chromium.flags.ts:headlessReason'],
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

  it('kunci tanpa default statis memang tak punya default (atau kosong)', () => {
    for (const key of NO_STATIC_DEFAULT) expect(specFor(key)?.default ?? '', key).toBe('')
  })

  it('setiap kunci registry non-bootstrap tercakup tepat satu tabel (kunci baru wajib menyatakan default pembacanya)', () => {
    const covered = [...READERS.map(([k]) => k), ...FLAGON_READERS.map(([k]) => k), ...NO_STATIC_DEFAULT]
    const missing = ENV_REGISTRY.map((s) => s.key).filter((k) => !isBootstrapOnly(k) && !covered.includes(k))
    expect(missing).toEqual([])
    expect(covered.filter((k, i) => covered.indexOf(k) !== i)).toEqual([])
    expect(covered.filter((k) => !specFor(k))).toEqual([])
  })
})
