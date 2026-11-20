// Policy over the recipe data: every command must work for an unprivileged user in a container (no sudo/apt),
// fetch only over https with certificate checks on, and cite its official source in the data file.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COMMAND_RECIPES, visibleRecipes } from './commands.recipes'

describe('command recipes', () => {
  it.each(COMMAND_RECIPES.map((r) => [r.id, r.command] as const))('%s: user-space, https only, TLS checked', (_id, cmd) => {
    expect(cmd).not.toMatch(/\bsudo\b|\bapt(-get)?\b|\bsu\b/)
    expect(cmd).not.toMatch(/(^|\s)(-k|--insecure|--no-check-certificate)(\s|$)/)
    expect(cmd).not.toMatch(/\bhttp:\/\//)
    expect(cmd).not.toMatch(/[\r\n]/)
    for (const url of cmd.match(/https?:\/\/\S+/g) ?? []) expect(url.startsWith('https://')).toBe(true)
  })
  it('ids are unique, and the data file names a source for each recipe', () => {
    expect(new Set(COMMAND_RECIPES.map((r) => r.id)).size).toBe(COMMAND_RECIPES.length)
    const src = readFileSync(new URL('./commands.recipes.ts', import.meta.url), 'utf8')
    expect((src.match(/\/\/ Sources?:/g) ?? []).length).toBe(COMMAND_RECIPES.length)
  })
  it('visibleRecipes hides installed tools and shows login chips only with their tool', () => {
    const ids = (found: string[]) => visibleRecipes(new Set(found)).map((r) => r.id)
    expect(ids([])).toEqual(['bun', 'node', 'python'])
    expect(ids(['bun', 'node', 'uv', 'gh', 'claude'])).toEqual(['gh-login', 'claude-login'])
  })
})
