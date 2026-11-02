// Read-only context-link backend: pure render/resolve helpers, the claude JSONL transcript parser,
// the POSIX-sh shim installer, and the renderForRequester entry the GET /api/context-link route
// calls. No write/inject path — a linked node only ever READS a peer it is bridged to.
//
// Public surface only; implementation lives in the sibling modules (file-health split):
//   contextLinkRender.ts     — types + pure render/parse helpers
//   contextLinkTranscript.ts — transcript file read + claude JSONL parser
//   contextLinkRoute.ts      — link-doc resolution + renderForRequester
//   contextLinkSkill.ts      — shim/skill builders + boot installer
export type { ContextLinkVerb, LinkDoc, LinkDocEntry } from './contextLinkRender'
export {
  CONTEXT_LINK_VERBS,
  parseSummaryCount,
  pickLinkNode,
  renderFullTranscript,
  renderList,
  renderSummary,
  renderTerminal,
  stripAnsi,
} from './contextLinkRender'
export { linesFromClaude, readTranscriptFile, renderTranscriptLines } from './contextLinkTranscript'
export { buildLinkDoc, findWorkspaceFor, renderForRequester } from './contextLinkRoute'
export {
  buildContextLinkSkillBody,
  buildContextShim,
  contextShimPath,
  installContextLink,
  SKILL_NAME,
} from './contextLinkSkill'
