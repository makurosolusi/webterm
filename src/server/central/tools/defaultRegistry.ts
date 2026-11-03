import { CORE_DEFS } from './defs/core.defs'
import { createRegistry } from './toolRegistry'
import type { ToolRegistry } from './toolTypes'

let shared: ToolRegistry | null = null
/** Process-wide registry holding the core tools; later workstreams register their defs here. */
export function defaultRegistry(): ToolRegistry {
  if (!shared) {
    shared = createRegistry()
    for (const def of CORE_DEFS) shared.register(def)
  }
  return shared
}
