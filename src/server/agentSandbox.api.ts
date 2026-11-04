// `GET /api/agents/protection`: per agent kind, whether webterm's same-uid hardening is a real
// boundary ("protected") or only a mitigation, with English reasons for the Control panel.
// Behind the normal /api gate; the body holds no secret and no path.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { agentProtection } from './agentSandbox'

export const AGENT_PROTECTION_PATH = '/api/agents/protection'

/** Handles the route and returns true, or returns false for any other path. */
export function agentProtectionRoute(req: IncomingMessage, res: ServerResponse, path: string, platform?: NodeJS.Platform): boolean {
  if (path !== AGENT_PROTECTION_PATH) return false
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET')
    res.end(JSON.stringify({ error: 'method_not_allowed' }))
    return true
  }
  res.statusCode = 200
  res.end(JSON.stringify(agentProtection(platform)))
  return true
}
