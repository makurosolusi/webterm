import { describe, expect, it } from 'vitest'
import { buildWorkerPrompt } from './workerRuntimePrompt'

const item = { id: 'i1', title: 'build the API', scope: ['src/server', 'src/api.ts'] }
const worktree = { path: '/tmp/wt/t1', branch: 'agent/t1' }

function build(extra?: string, maxBytes = 4000): string {
  return buildWorkerPrompt({
    item,
    worktree,
    attempt: 2,
    maxBytes,
    ...(extra === undefined ? {} : { extra }),
  })
}

describe('buildWorkerPrompt one-line delivery', () => {
  it('emits no newline so exactly one Enter submits the whole prompt', () => {
    const prompt = build()
    expect(prompt).not.toMatch(/[\r\n]/)
    expect(prompt).toContain('src/server')
    expect(prompt).toContain('src/api.ts')
    expect(prompt).toContain('/tmp/wt/t1')
    expect(prompt).toContain('agent/t1')
    expect(prompt).toContain('build the API')
    expect(prompt).toContain('attempt 2')
    expect(prompt).toContain('Do not push')
  })

  it('collapses multi-line extra instructions and keeps every instruction', () => {
    const prompt = build('fix the failing tests\n\nthen commit\r\nand stop')
    expect(prompt).not.toMatch(/[\r\n]/)
    expect(prompt).toContain('fix the failing tests')
    expect(prompt).toContain('then commit')
    expect(prompt).toContain('and stop')
    expect(prompt).toContain('Worktree: /tmp/wt/t1')
  })

  it('stays single-line and within the byte cap when truncated', () => {
    const prompt = build('z'.repeat(5000), 200)
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(200)
    expect(prompt).not.toMatch(/[\r\n]/)
  })

  it('strips terminal escapes but adds no Enter', () => {
    const prompt = build('\u001b[31mred\u001b[0m task')
    expect(prompt).not.toContain('\u001b')
    expect(prompt).not.toMatch(/[\r\n]/)
    expect(prompt).toContain('red task')
  })
})
