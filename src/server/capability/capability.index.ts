// Every route-bound capability (control verbs + git reads) in one list, so projections that are not
// Central (MCP today, CLI next) read the registry from one place instead of importing each family.
import { CONTROL_CAPABILITIES } from './control.capabilities'
import { GIT_CAPABILITIES } from './git.capabilities'
import { type CapabilitySpec, createCapabilityIndex } from './capability.define'

/** Capabilities whose handler is an HTTP route (control + git), in declaration order. */
export const ROUTE_CAPABILITIES: readonly CapabilitySpec[] = [...CONTROL_CAPABILITIES, ...GIT_CAPABILITIES]

/** Index over the route capabilities plus `extra` (e.g. the Central tools a caller has enabled). */
export const registryIndex = (extra: readonly CapabilitySpec[] = []) => createCapabilityIndex([...ROUTE_CAPABILITIES, ...extra])
