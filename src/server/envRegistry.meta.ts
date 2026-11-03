// Derivasi metadata v2 dari spec registry: entri lama/domain lain valid tanpa diedit.
import type { EnvAudience, EnvRequire, EnvRestart, EnvStage } from '../shared/envSettings.contract'
import { groupMetaFor } from './envRegistry.groups'
import type { EnvSpec } from './envRegistry.types'

/** Domain (owner) yang wajib menyatakan audience+owner eksplisit pada tiap entri (diperiksa invarian ENV-02). */
export const EXPLICIT_DOMAINS: ReadonlySet<string> = new Set(['channels', 'central', 'platform', 'logs'])

export interface ResolvedMeta {
  owner: string
  section: string
  audience: EnvAudience
  requires: EnvRequire[]
  restart: EnvRestart
  effectiveDefault?: string
  stage?: EnvStage
  aliases: string[]
}

/**
 * Metadata efektif sebuah spec. `audience:'user'` hanya dipakai bila dinyatakan eksplisit, dan di
 * domain yang belum terdaftar di EXPLICIT_DOMAINS juga butuh `owner` eksplisit; selain itu 'advanced'.
 */
export function resolveMeta(spec: EnvSpec): ResolvedMeta {
  const grp = groupMetaFor(spec.group)
  const owner = spec.owner ?? grp.owner
  const declared = spec.audience === 'user' && (EXPLICIT_DOMAINS.has(owner) || spec.owner !== undefined)
  return {
    owner,
    section: spec.section ?? grp.label,
    audience: declared ? 'user' : 'advanced',
    requires: spec.requires ?? [],
    restart: spec.restart ?? (spec.restartRequired ? 'boot' : 'hot'),
    ...(spec.effectiveDefault === undefined ? {} : { effectiveDefault: spec.effectiveDefault }),
    ...(spec.stage === undefined ? {} : { stage: spec.stage }),
    aliases: spec.aliases ?? [],
  }
}
