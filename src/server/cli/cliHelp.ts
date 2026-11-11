// Text builders for the server CLI: help, version, env reference, README topics. Pure (README text is
// passed in) so vitest can test them; env sections are generated from the registry so they cannot drift.
import { resolveMeta } from '../envRegistry.meta'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY } from '../envRegistry'
import { BOOTSTRAP_ENV_DOCS } from '../envRegistry.bootstrap'
import { DEFAULT_HOST } from '../auth'
import { DEFAULT_PORT } from '../serverConfig'
import { CLI_OPTIONS } from './cliArgs'

export const ENV_TOPIC = 'env'

interface EnvLine { key: string; description: string; default?: string }

/** First sentence, so a long registry description stays on one help line. */
function firstSentence(text: string): string {
  const m = /^(.+?\.)(\s|$)/.exec(text.trim())
  return m ? m[1] : text.trim()
}

function bootstrapLines(): EnvLine[] {
  return BOOTSTRAP_ONLY_KEYS.map((key) => ({ key, ...(BOOTSTRAP_ENV_DOCS[key] ?? { description: '' }) }))
}

function registryLines(userOnly: boolean): EnvLine[] {
  return ENV_REGISTRY.filter((s) => !userOnly || resolveMeta(s).audience === 'user')
    .map((s) => ({ key: s.key, description: firstSentence(s.description), default: s.default }))
}

function formatEnv(lines: readonly EnvLine[]): string {
  const width = Math.max(...lines.map((l) => l.key.length))
  return lines.map((l) => `  ${l.key.padEnd(width)}  ${l.description}${l.default ? ` (default: ${l.default})` : ''}`).join('\n')
}

/** `webterm --help`: usage, options, startup + user-facing env vars, examples. */
export function buildHelp(): string {
  const flags = CLI_OPTIONS.map((o) => `${o.short ? `${o.short}, ` : '    '}${o.long}${o.arg ? ` ${o.arg}` : ''}`)
  const width = Math.max(...flags.map((f) => f.length))
  return [
    'webterm - node-based terminal manager in the browser',
    '',
    'Usage: webterm [options]',
    '',
    'With no options, starts the server (http://HOST:PORT).',
    '',
    'Options:',
    ...CLI_OPTIONS.map((o, i) => `  ${flags[i].padEnd(width)}  ${o.description}`),
    '',
    'Startup environment (read only from the environment):',
    formatEnv(bootstrapLines()),
    '',
    'Common settings (also editable in Settings):',
    formatEnv(registryLines(true)),
    '',
    `Every variable: webterm --docs ${ENV_TOPIC}`,
    '',
    'Examples:',
    `  webterm                  Start on http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    '  PORT=9000 webterm        Start on another port',
    '  webterm --docs           List documentation topics',
    `  webterm --docs ${ENV_TOPIC}       Full environment reference`,
    '  webterm --reset-password alice   Set a new password for alice (prompts twice)',
    '',
  ].join('\n')
}

/** `webterm --version`: `webterm <version> (<build tag>)`, build = `<version>+<tag>` from health.api. */
export function buildVersion(version: string, build: string): string {
  const tag = build.startsWith(`${version}+`) ? build.slice(version.length + 1) : build
  return `webterm ${version} (${tag})\n`
}

/** Full env reference (`--docs env`): bootstrap keys, then every registry key with its full description. */
export function buildEnvReference(): string {
  const all = ENV_REGISTRY.map((s) => ({ key: s.key, description: s.description, default: s.default }))
  return [
    '# Environment variables',
    '',
    'Startup (environment only):',
    formatEnv(bootstrapLines()),
    '',
    'Settings (environment, or Settings in the UI; Settings wins):',
    formatEnv(all),
    '',
  ].join('\n')
}

export interface ReadmeTopic { slug: string; title: string; body: string }

/** `## Heading` -> `heading`; punctuation dropped, spaces to dashes (`Build / production` -> `build-production`). */
export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-')
}

/** README `##` sections (headings inside code fences ignored), each with its body up to the next `##`. */
export function readmeTopics(readme: string): ReadmeTopic[] {
  const topics: ReadmeTopic[] = []
  let fenced = false
  for (const line of readme.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced
    const m = fenced ? null : /^## (.+)$/.exec(line)
    if (m) topics.push({ slug: slugify(m[1]), title: m[1].trim(), body: line })
    else if (topics.length > 0) topics[topics.length - 1].body += `\n${line}`
  }
  return topics.map((t) => ({ ...t, body: `${t.body.trimEnd()}\n` }))
}

/** `webterm --docs` without a topic: README topics plus the generated `env` topic. */
export function buildTopicList(readme: string): string {
  const rows = [...readmeTopics(readme).map((t) => ({ slug: t.slug, title: t.title })), { slug: ENV_TOPIC, title: 'Environment variables (generated)' }]
  const width = Math.max(...rows.map((r) => r.slug.length))
  return ['Documentation topics:', ...rows.map((r) => `  ${r.slug.padEnd(width)}  ${r.title}`), '', 'Run: webterm --docs <topic>', ''].join('\n')
}

/** Text of one topic, or undefined for an unknown slug. */
export function docsTopic(readme: string, slug: string): string | undefined {
  if (slug === ENV_TOPIC) return buildEnvReference()
  return readmeTopics(readme).find((t) => t.slug === slug.toLowerCase())?.body
}

/** Every valid topic slug (for the unknown-topic error). */
export function topicSlugs(readme: string): string[] {
  return [...readmeTopics(readme).map((t) => t.slug), ENV_TOPIC]
}
