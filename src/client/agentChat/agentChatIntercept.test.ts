import { describe, expect, it } from 'vitest'
import { interceptOf, LOCAL_COMMANDS } from './agentChatIntercept'

describe('interceptOf', () => {
  it('maps the picker and clear commands, aliases and arguments included', () => {
    expect(interceptOf('/model')).toBe('model')
    expect(interceptOf('  /model sonnet')).toBe('model')
    expect(interceptOf('/resume')).toBe('resume')
    expect(interceptOf('/continue')).toBe('resume')
    expect(interceptOf('/clear')).toBe('clear')
    expect(interceptOf('/RESET')).toBe('clear')
    expect(interceptOf('/new\n')).toBe('clear')
  })

  it('sends everything else', () => {
    expect(interceptOf('/compact keep the plan')).toBeNull()
    expect(interceptOf('/models')).toBeNull()
    expect(interceptOf('/constructor')).toBeNull()
    expect(interceptOf('please /clear this')).toBeNull()
    expect(interceptOf('model')).toBeNull()
    expect(interceptOf('')).toBeNull()
  })

  it('every local menu entry is intercepted', () => {
    expect(LOCAL_COMMANDS.map((c) => interceptOf(`/${c.name}`))).toEqual(['model', 'resume'])
  })
})
