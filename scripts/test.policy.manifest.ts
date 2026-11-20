// Scanner tests: guards that read many source files, so `vitest related` / the import graph never
// selects them. `npm run test:impacted` runs the ones whose domain a change touches. The list must
// not go stale: scripts/test.policy.manifest.bun.test.ts discovers every scanner-style test and fails
// when one is missing here (or listed but gone). Add a new scanner under the domain of the tree it reads.
//
// Domains and what triggers them (see policyDomainsFor in scripts/test.impacted.plan.ts):
//   client  reads src/client             <- changes in src/client or src/shared
//   server  reads src/server             <- changes in src/server or src/shared
//   shared  reads src/shared only        <- changes in src/shared
//   docs    reads docs/ or README        <- changes in docs/ or *.md
//   all     reads several trees (or src/shared, which both sides import) <- any source change
// Tests, build/test infrastructure (scripts/, package.json, vite.config.ts, ...) trigger every domain.
// Initial classification is by the tree each test scans; fix a wrong one rather than widening it.

export type PolicyDomain = 'client' | 'server' | 'shared' | 'docs' | 'all'

export const POLICY_MANIFEST: Record<PolicyDomain, string[]> = {
  client: [
    'src/client/EditorNode.save.test.tsx',
    'src/client/PolicyRules.test.tsx',
    'src/client/PolicySimulator.test.tsx',
    'src/client/actionFeedbackPolicy.test.ts',
    'src/client/centralAct.policy.test.ts',
    'src/client/clientAuth.policy.test.ts',
    'src/client/commandRegistry.labels.policy.test.ts',
    'src/client/customCommands/commands.recipes.policy.test.ts',
    'src/client/components/ui/icon-button.policy.test.ts',
    'src/client/cssTranslateResetPolicy.test.ts',
    'src/client/eventSource.policy.test.ts',
    'src/client/headerMode.css.test.ts',
    'src/client/filesToolbarPolicy.test.tsx',
    'src/client/iconTooltipPolicy.test.ts',
    'src/client/independentSource.policy.test.ts',
    'src/client/nativeBranch.policy.test.ts',
    'src/client/nodeHeaderIconPolicy.test.tsx',
    'src/client/nodeResizePolicy.test.ts',
    'src/client/paletteColorPolicy.test.ts',
    'src/client/policyPresets.test.ts',
    'src/client/sessionsGroupSwitch.policy.test.tsx',
    'src/client/sessionsStacked.policy.test.tsx',
    'src/client/settings.link.policy.test.ts',
    'src/client/settings.search.policy.test.ts',
    'src/client/shadcnPolicy.test.ts',
    'src/client/dock.rail.policy.test.ts',
    'src/client/wrapperNeutral.policy.test.ts',
  ],
  server: [
    'src/server/agentSubmit.policy.test.ts',
    'src/server/browser/browser.idle.policy.test.ts',
    'src/server/browser/cookieImportPolicy.test.ts',
    'src/server/browser/windowSurfacing.policy.test.ts',
    'src/server/central/agents/agentLadder.test.ts',
    'src/server/central/context/rotationPolicy.test.ts',
    'src/server/central/internalCatch.policy.test.ts',
    'src/server/central/tools/defs/central.autonomy.default.policy.bun.test.ts',
    'src/server/central/tools/defs/central.freedom.policy.bun.test.ts',
    'src/server/central/tools/defs/health.tools.policy.bun.test.ts',
    'src/server/central/tools/defs/task.work.policy.bun.test.ts',
    'src/server/central/work/workCheckin.callers.bun.test.ts',
    'src/server/central/work/workRecover.policy.bun.test.ts',
    'src/server/childEnv.bun.test.ts',
    'src/server/claudeLaunchPolicy.test.ts',
    'src/server/claudeProviderEnv.policy.bun.test.ts',
    'src/server/credentialProxy/credentialProxy.env.policy.bun.test.ts',
    'src/server/credentialProxy/credentialProxy.spawn.policy.test.ts',
    'src/server/db.preserveNodes.bun.test.ts',
    'src/server/envModuleRead.test.ts',
    'src/server/envRegistry.invariants.test.ts',
    'src/server/envRegistry.readers.test.ts',
    'src/server/featureCapabilities.final.test.ts',
    'src/server/featureCapabilities.grep.test.ts',
    'src/server/gitExec.bun.test.ts',
    'src/server/ledger/ledgerRetention.policy.bun.test.ts',
    'src/server/memory/memoryTrust.policy.bun.test.ts',
    'src/server/policy/policy.bun.test.ts',
    'src/server/policy/policy.classifier.bun.test.ts',
    'src/server/policy/policy.classifier.test.ts',
    'src/server/policy/policy.model.test.ts',
    'src/server/policy/policy.wiring.bun.test.ts',
    'src/server/routes/route.core.body.bun.test.ts',
    'src/server/routes/route.uiOnly.policy.bun.test.ts',
    'src/server/settings.defaults.policy.test.ts',
    'src/server/setupCode.removed.policy.test.ts',
  ],
  shared: [],
  docs: [],
  all: [
    'scripts/test.policy.manifest.bun.test.ts',
    'src/client/central/toolLabels.test.ts',
    'src/native/updatePolicy.bun.test.ts',
    'src/shared/agentCapabilities.parity.test.ts',
    'src/shared/composePortainer.policy.test.ts',
    'src/shared/containment.policy.test.ts',
    'src/shared/capabilityProse.grep.test.ts',
    'src/shared/independentRewrite.policy.test.ts',
    'src/shared/productText.english.test.ts',
    'src/shared/settings.readers.test.ts',
  ],
}

/** Every manifest entry, flat. */
export const policyFiles = (): string[] => Object.values(POLICY_MANIFEST).flat()
