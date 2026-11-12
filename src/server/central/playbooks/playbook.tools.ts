// One Central tool per playbook (`playbook.<id>`), registered by tools/registerAll.ts with the agent tools.
import { S } from '../../capability/capability.schema'
import type { ToolDef, ToolInput } from '../tools/toolTypes'
import { PLAYBOOKS, type Playbook, playbookTool } from './playbook.defs'
import { type PlaybookDeps, runPlaybook } from './playbook.run'

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/
const URL_KEYS = new Set(['url'])

function shapeOk(pb: Playbook, input: ToolInput): boolean {
  const props = Object.keys(pb.params.properties ?? {})
  return Object.entries(input).every(([k, v]) => {
    if (k === 'projectId') return true
    if (!props.includes(k) || typeof v !== 'string' || CONTROL.test(v)) return false
    return !URL_KEYS.has(k) || /^https?:\/\/\S+$/i.test(v.trim())
  }) && pb.required.every((k) => typeof input[k] === 'string' && (input[k] as string).trim() !== '')
}

function usageOf(pb: Playbook): string {
  const fields = Object.keys(pb.params.properties ?? {}).map((k) => `"${k}":"<${pb.required.includes(k) ? '' : 'optional '}${k}>"`)
  return `{"projectId":"<id>",${fields.join(',')}}. Runs ${pb.steps.map((s) => s.tool).join(' -> ')} for you and answers {runId, taskId, step, status}; `
    + 'an approval card parks it and webterm continues it by itself once the card is decided. The agent replies with a RESULT: line.'
}

export function createPlaybookDefs(deps: PlaybookDeps = {}): ToolDef[] {
  return PLAYBOOKS.map((pb): ToolDef => ({
    name: playbookTool(pb.id), summary: pb.summary, tier: pb.tier, usage: usageOf(pb),
    input: pb.params, output: S.keys('runId', 'taskId', 'step', 'status', 'agentId'),
    auditKeys: ['runId', 'taskId', 'step', 'status', 'agentId', 'approvalId'],
    validate: (input) => (shapeOk(pb, input) ? null : 'invalid_shape'),
    handler: (ctx, input, projectId) => runPlaybook(ctx, pb, input, projectId as string, deps),
  }))
}
