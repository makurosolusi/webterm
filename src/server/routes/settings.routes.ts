// Settings surfaces: env settings + import, feature capabilities, agent protection, custom agents
// preview, and /api/settings (which re-applies PTY options on save).
import { db } from '../db'
import { sessions } from '../sessions'
import { settingsRoute } from '../settingsApi'
import { CUSTOM_AGENTS_PREVIEW_PATH, customAgentsPreviewRoute } from '../customAgentsApi'
import { ENV_SETTINGS_PATH, IMPORT_ENDPOINT, envImportRoute, envSettingsRoute } from '../envSettings.api'
import { envSettingsApiDeps } from '../envSettings.runtime'
import { capabilitiesRoute } from '../featureCapabilities.api'
import { agentProtectionRoute } from '../agentSandbox.api'
import { json, type ApiRoute } from './route.core'
import { installedShells, SHELLS_PATH } from '../shells'
import { canvasBackgroundRoutes } from './canvasBackground.routes'
import { effectiveClaudeMode, launchModeFor } from '../permission/permission.mode'
import { APPROVAL_SESSIONS_PATH, approvalSessions, recordLevelChanges, switchAgentChats } from '../permission/permission.levelChange'
import { approvalLevelFor } from '../../shared/settings.projectApprovalLevels'
import { findWorkspaceFor } from '../contextLink'
import { createLogger } from '../logs'
import { applyApprovalLevelSwitch } from '../policy/policy.approvalLevel'

/** Push the stored shell/scrollback/agent settings into the live PTY factory. Boot + every PUT. */
export function applyPtyOptions(): void {
  const s = db.getSettings()
  const mode = effectiveClaudeMode(s.claudePermissionMode, undefined, s.skipApprovals)
  sessions.options = {
    shell: s.defaultShell,
    scrollbackBytes: s.scrollbackBytes,
    // Same mode Agent Chat gets (agentChat.runtime.ts): `auto` is passed through, not dropped.
    claudePermissionMode: mode,
    hookReplyApprovals: s.hookReplyApprovals,
    // Per node, read at launch: the approval level of the node's workspace (its override, else global).
    launchFor: (nodeId) => {
      const now = db.getSettings()
      const workspaceId = findWorkspaceFor(db.list(), nodeId)?.id ?? null
      return { mode: launchModeFor(now, workspaceId), workspaceId, level: approvalLevelFor(now, workspaceId) }
    },
  }
}

const log = createLogger('settings')

export const settingsRoutes: ApiRoute[] = [
  { name: 'env-settings', match: (c) => c.path === ENV_SETTINGS_PATH, handle: async (c) => { await envSettingsRoute(c.req, c.res, c.method, envSettingsApiDeps()); return true } },
  { name: 'env-import', match: (c) => c.path === IMPORT_ENDPOINT, handle: async (c) => { await envImportRoute(c.req, c.res, c.method, envSettingsApiDeps()); return true } },
  { name: 'capabilities', handle: (c) => capabilitiesRoute(c.req, c.res, c.method, c.path, envSettingsApiDeps) },
  { name: 'agent-protection', handle: (c) => agentProtectionRoute(c.req, c.res, c.path) },
  { name: 'custom-agents-preview', match: (c) => c.path === CUSTOM_AGENTS_PREVIEW_PATH, handle: async (c) => { await customAgentsPreviewRoute(c.req, c.res, c.method); return true } },
  // Default shell picker: only shells installed on this machine.
  { name: 'shells', match: (c) => c.path === SHELLS_PATH && c.method === 'GET', handle: (c) => { json(c.res, 200, { shells: installedShells() }); return true } },
  {
    name: 'settings',
    match: (c) => c.path === '/api/settings',
    handle: async (c) => {
      const prev = db.getSettings()
      await settingsRoute(c.req, c.res, c.method, db, (patch) => {
        applyApprovalLevelSwitch(patch, c.ledger())
        const next = db.getSettings()
        // Transparent and live: one event per changed scope, running Agent Chats follow at once.
        const changes = recordLevelChanges(prev, next, 'human-ui')
        switchAgentChats(changes, next).catch((err: unknown) => log.error('settings.mode_switch_failed', 'Switching agent chats to the new level failed', { cause: err instanceof Error ? err.message : String(err) }))
      })
      // A saved defaultShell/scrollbackBytes must reach the NEXT spawned PTY without a restart.
      if (c.method === 'PUT') applyPtyOptions()
      return true
    },
  },
  // Read-only: the level in a workspace and how many running terminal sessions keep an older one until restarted.
  {
    name: 'approval-sessions',
    match: (c) => c.path === APPROVAL_SESSIONS_PATH && c.method === 'GET',
    handle: (c) => {
      const ws = c.url.searchParams.get('workspaceId') || undefined
      json(c.res, 200, approvalSessions(db.getSettings(), (id) => sessions.isLive(id), ws))
      return true
    },
  },
  // Canvas wallpaper upload/serve; writes the same settings row.
  ...canvasBackgroundRoutes(db),
]
