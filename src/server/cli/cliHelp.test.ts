import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY } from '../envRegistry'
import { BOOTSTRAP_ENV_DOCS } from '../envRegistry.bootstrap'
import { resolveMeta } from '../envRegistry.meta'
import { CLI_OPTIONS } from './cliArgs'
import { buildEnvReference, buildHelp, buildTopicList, buildVersion, docsTopic, readmeTopics, slugify, topicSlugs } from './cliHelp'

const README = readFileSync(join(import.meta.dirname, '../../../README.md'), 'utf8')

describe('buildHelp', () => {
  const help = buildHelp()

  it('lists every flag', () => {
    for (const o of CLI_OPTIONS) expect(help).toContain(`${o.short}, ${o.long}`)
  })

  it('lists every bootstrap key and every user-facing registry key, not advanced ones', () => {
    for (const k of BOOTSTRAP_ONLY_KEYS) expect(help).toMatch(new RegExp(`^  ${k} `, 'm'))
    const user = ENV_REGISTRY.filter((s) => resolveMeta(s).audience === 'user')
    expect(user.length).toBeGreaterThan(0)
    for (const s of user) expect(help).toMatch(new RegExp(`^  ${s.key} `, 'm'))
    const advanced = ENV_REGISTRY.find((s) => resolveMeta(s).audience !== 'user')
    expect(advanced).toBeDefined()
    expect(help).not.toMatch(new RegExp(`^  ${advanced?.key} `, 'm'))
  })
})

describe('bootstrap env docs', () => {
  it('documents exactly the bootstrap keys', () => {
    expect(Object.keys(BOOTSTRAP_ENV_DOCS).sort()).toEqual([...BOOTSTRAP_ONLY_KEYS].sort())
    for (const d of Object.values(BOOTSTRAP_ENV_DOCS)) expect(d.description.length).toBeGreaterThan(0)
  })
})

describe('buildVersion', () => {
  it('shows the build tag without repeating the version', () => {
    expect(buildVersion('1.2.3', '1.2.3+abc123')).toBe('webterm 1.2.3 (abc123)\n')
    expect(buildVersion('1.2.3', '1.2.3+dev')).toBe('webterm 1.2.3 (dev)\n')
  })
})

describe('docs topics', () => {
  it('slugifies headings', () => {
    expect(slugify('Build / production')).toBe('build-production')
    expect(slugify('`webterm` CLI')).toBe('webterm-cli')
    expect(slugify('Run (dev)')).toBe('run-dev')
  })

  it('derives topics from the README ## headings plus env', () => {
    const headings = README.split('\n').filter((l) => l.startsWith('## ')).map((l) => slugify(l.slice(3)))
    expect(headings.length).toBeGreaterThan(3)
    expect(topicSlugs(README)).toEqual([...headings, 'env'])
    const list = buildTopicList(README)
    for (const h of headings) expect(list).toContain(h)
  })

  it('a topic is its section up to the next ##, ignoring headings in code fences', () => {
    const md = '# T\nintro\n## One\na\n```sh\n## not a heading\n```\n## Two\nb\n'
    expect(readmeTopics(md).map((t) => t.slug)).toEqual(['one', 'two'])
    expect(docsTopic(md, 'one')).toBe('## One\na\n```sh\n## not a heading\n```\n')
    expect(docsTopic(md, 'TWO')).toBe('## Two\nb\n')
    expect(docsTopic(md, 'nope')).toBeUndefined()
  })

  it('env topic is the full registry reference', () => {
    const ref = buildEnvReference()
    expect(docsTopic(README, 'env')).toBe(ref)
    for (const s of ENV_REGISTRY) expect(ref).toContain(s.key)
    for (const k of BOOTSTRAP_ONLY_KEYS) expect(ref).toContain(k)
  })
})
