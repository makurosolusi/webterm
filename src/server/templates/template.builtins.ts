// The three built-in templates (F6). Read-only, always listed first; validated at load like an import.
import { AGENT_CONFIG } from '../../shared/workspace'
import { validateTemplate, type WebtermTemplate } from './template.model'

const CLAUDE = { agentId: 'claude', cmd: AGENT_CONFIG.claude.launchCmd, color: AGENT_CONFIG.claude.color }
const REPO = { id: 'repo', description: 'Repository folder (absolute path) the agents work in.' }
const SIZE = { width: 640, height: 420 }

const RAW: unknown[] = [
  {
    format: 'webterm-template', version: 1, id: 'claude-browser-pair', name: 'Claude + browser pair',
    description: 'A Claude Code agent wired to a browser node it can drive, opened on your app.',
    cwd: '{{repo}}',
    params: [
      REPO,
      { id: 'url', description: 'Page the browser opens.', default: 'http://localhost:3000' },
      { id: 'task', description: 'What the agent should do with the page.', default: 'Check the page for visual and console errors.' },
    ],
    nodes: [
      { key: 'agent', kind: 'agent', x: 0, y: 0, ...SIZE, ...CLAUDE, title: 'Claude', notes: ['Task: {{task}}'] },
      { key: 'browser', kind: 'browser', x: 700, y: 0, ...SIZE, title: 'Browser', url: '{{url}}' },
    ],
    cables: [{ from: 'agent', to: 'browser', kind: 'context' }],
  },
  {
    format: 'webterm-template', version: 1, id: 'plan-worktree-workers', name: 'Plan → worktree workers',
    description: 'A Plan node for the task plus two Claude workers, each on its own git worktree branch.',
    cwd: '{{repo}}',
    params: [
      REPO,
      { id: 'task', description: 'The intent the plan breaks down.' },
      { id: 'branch', description: 'Branch prefix for the worker worktrees.', default: 'feature/work' },
    ],
    nodes: [
      { key: 'plan', kind: 'plan', x: 0, y: 0, width: 520, height: 460, title: 'Plan', plan: { intent: '{{task}}' } },
      { key: 'w1', kind: 'agent', x: 580, y: 0, ...SIZE, ...CLAUDE, title: 'Worker 1', worktree: { branch: '{{branch}}-1' }, notes: ['Part of: {{task}}'] },
      { key: 'w2', kind: 'agent', x: 580, y: 460, ...SIZE, ...CLAUDE, title: 'Worker 2', worktree: { branch: '{{branch}}-2' }, notes: ['Part of: {{task}}'] },
    ],
    cables: [{ from: 'w1', to: 'w2', kind: 'context' }],
  },
  {
    format: 'webterm-template', version: 1, id: 'pr-review-desk', name: 'PR review desk',
    description: 'A read-only review agent, the working diff and the PR page side by side, plus a PR review routine (created paused).',
    cwd: '{{repo}}',
    params: [
      REPO,
      { id: 'github', description: 'GitHub repository as owner/name.' },
      { id: 'pr', description: 'Pull request number.' },
    ],
    nodes: [
      { key: 'reviewer', kind: 'agent', x: 0, y: 0, ...SIZE, ...CLAUDE, title: 'Reviewer', notes: ['Review PR #{{pr}} of {{github}}. Report findings; do not edit files or push.'] },
      { key: 'diff', kind: 'diff', x: 700, y: 0, ...SIZE, title: 'Changes' },
      { key: 'pr', kind: 'browser', x: 0, y: 480, ...SIZE, title: 'PR #{{pr}}', url: 'https://github.com/{{github}}/pull/{{pr}}' },
    ],
    cables: [{ from: 'reviewer', to: 'pr', kind: 'context' }],
    routines: [
      { name: 'Review new PR heads', trigger: { type: 'schedule', cron: '0 * * * *' }, precheck: null, action: { type: 'prreview' }, budget: { maxRunsPerDay: 24 } },
    ],
  },
]

export const BUILTIN_TEMPLATES: readonly WebtermTemplate[] = RAW.map((t) => ({ ...validateTemplate(t), builtin: true }))
