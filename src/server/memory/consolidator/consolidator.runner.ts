// The consolidator's model call: the shared helper runner (claudeStructured.ts) on haiku at low effort. It
// returns the CLI's usage instead of booking it, because the run books it itself under its own run id
// (recordRunUsage), which the daily token cap reads back.
import { createStructuredRunner, type StructuredAnswer, type StructuredOptions, type StructuredRun } from '../../central/context/claudeStructured'

export type ModelAnswer = StructuredAnswer
/** Prompt + schema in, structured output + usage out. Tests inject a fake; nothing in a test reaches a model. */
export type ConsolidatorModel = StructuredRun

/** Real runner; `bin` is overridable so a test can point it at a stub script. */
export function createClaudeConsolidatorModel(opts: StructuredOptions = {}): ConsolidatorModel {
  return createStructuredRunner('consolidator', opts)
}
