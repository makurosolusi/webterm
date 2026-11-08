import { describe, expect, it } from 'vitest'
import { frontmatterRows, splitFrontmatter } from './markdownFrontmatter'

describe('splitFrontmatter', () => {
  it('splits a leading --- block off the body', () => {
    expect(splitFrontmatter('---\nname: laya\ndescription: A skill\n---\n# Title\n')).toEqual({
      front: 'name: laya\ndescription: A skill', body: '# Title\n'
    })
  })

  it('accepts CRLF, a BOM, an empty block and the YAML `...` terminator', () => {
    expect(splitFrontmatter('﻿---\r\na: 1\r\n---\r\nx')).toEqual({ front: 'a: 1', body: 'x' })
    expect(splitFrontmatter('---\n---\nx')).toEqual({ front: '', body: 'x' })
    expect(splitFrontmatter('---\na: 1\n...\nx')).toEqual({ front: 'a: 1', body: 'x' })
  })

  it('leaves a --- block that is not on the first line, or never closes, in the body', () => {
    const mid = 'Intro\n\n---\na: b\n---\n'
    expect(splitFrontmatter(mid)).toEqual({ front: null, body: mid })
    expect(splitFrontmatter('---\na: b\n')).toEqual({ front: null, body: '---\na: b\n' })
    expect(splitFrontmatter('--- not yaml\n')).toEqual({ front: null, body: '--- not yaml\n' })
  })
})

describe('frontmatterRows', () => {
  it('flat scalars become rows, quotes dropped, comments skipped', () => {
    expect(frontmatterRows('# c\nname: laya\ndescription: "Use when: x"\nversion: 2')).toEqual([
      ['name', 'laya'], ['description', 'Use when: x'], ['version', '2']
    ])
  })

  it('anything nested returns null (caller shows raw YAML)', () => {
    expect(frontmatterRows('name: x\ntags:\n  - a\n  - b')).toBeNull()
    expect(frontmatterRows('meta:\n  owner: me')).toBeNull()
    expect(frontmatterRows('body: |\n  line')).toBeNull()
    expect(frontmatterRows('- a')).toBeNull()
  })
})
