// Who answers a Claude permission prompt held by a worker's hook (docs/decisions/central-approver.md):
// `central` = the Central agent decides first and escalates to the human; `human` = straight to the Inbox.
export const PERMISSION_ROUTINGS = ['central', 'human'] as const
export type PermissionRouting = (typeof PERMISSION_ROUTINGS)[number]
export const DEFAULT_PERMISSION_ROUTING: PermissionRouting = 'central'

/** `v` when it is a known routing, else the default (an unknown stored string never reaches the runtime). */
export const permissionRoutingOf = (v: unknown): PermissionRouting =>
  (PERMISSION_ROUTINGS as readonly unknown[]).includes(v) ? (v as PermissionRouting) : DEFAULT_PERMISSION_ROUTING
