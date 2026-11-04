// Human approvals, policy rules, secret broker, procedural memory. The last three are UI-only and
// MUST stay ahead of the generic memory writes in ledger.routes (agent credentials get 403 here).
import { approvalHumanRoute } from '../approvalHumanApi'
import { policyRoute } from '../policy/policy.api'
import { secretsRoute } from '../secrets/secret.api'
import { proceduralRoute } from '../awareness/procedural.api'
import type { ApiRoute } from './route.core'

export const policyRoutes: ApiRoute[] = [
  { name: 'approval-human', handle: (c) => approvalHumanRoute(c.req, c.res, c.url) },
  // Policy rule amendments: UI-only (K4); agent credentials get 403 agent_cannot_grant.
  { name: 'policy', handle: (c) => policyRoute(c.req, c.res, c.url) },
  // Secret broker values: UI-only (secrets/secret.api.ts)
  { name: 'secrets', handle: (c) => secretsRoute(c.req, c.res, c.url) },
  // Procedural memory ("What agents remember"): UI-only like policy; agent credentials get 403.
  { name: 'procedural', handle: (c) => proceduralRoute(c.req, c.res, c.url) },
]
