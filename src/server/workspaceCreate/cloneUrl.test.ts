import { describe, expect, it } from 'vitest'
import { cloneErrorMessage, deriveRepoDirName, expandCloneUrl, isValidCloneUrl, parseCloneProgress, redactCredentials } from './cloneUrl'

describe('clone URL rules', () => {
  it('expands owner/repo to a GitHub https URL and passes the rest through', () => {
    expect(expandCloneUrl(' vercel/next.js ')).toBe('https://github.com/vercel/next.js.git')
    expect(expandCloneUrl('o/r.git')).toBe('https://github.com/o/r.git')
    expect(expandCloneUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git')
    expect(expandCloneUrl('../etc')).toBe('../etc')
  })

  it('accepts https, ssh:// and git@host:path only', () => {
    for (const ok of ['https://github.com/o/r.git', 'https://gitlab.com/g/sub/r', 'ssh://git@host.example/o/r.git', 'git@github.com:o/r.git'])
      expect(isValidCloneUrl(ok), ok).toBe(true)
    for (const bad of ['file:///etc/passwd', 'ext::sh -c touch% /tmp/pwned', '-uhttps://x/y', '--upload-pack=id', 'http://github.com/o/r',
      'git://github.com/o/r', '/abs/repo', '../rel', 'ssh://-oProxyCommand=id/x', 'git@host:-oProxyCommand=id', 'https://github.com/o/r\nx', ''])
      expect(isValidCloneUrl(bad), bad).toBe(false)
  })

  it('derives a safe folder name or null', () => {
    expect(deriveRepoDirName('https://github.com/o/my-repo.git')).toBe('my-repo')
    expect(deriveRepoDirName('git@github.com:o/r')).toBe('r')
    expect(deriveRepoDirName('https://github.com/o/..')).toBeNull()
  })

  it('parses the last progress line of a chunk', () => {
    expect(parseCloneProgress('Counting objects:  5% (1/20)\rReceiving objects:  42% (8/20)\r')).toEqual({ phase: 'Receiving objects', percent: 42 })
    expect(parseCloneProgress('Cloning into x...\n')).toBeNull()
  })

  it('reports the fatal line, redacted, with the gh hint on auth failure', () => {
    expect(redactCredentials('https://u:tok@github.com/x')).toBe('https://***@github.com/x')
    const msg = cloneErrorMessage("Cloning into 'r'...\nremote: Repository not found.\nfatal: repository 'https://tok@github.com/o/r.git/' not found\n")
    expect(msg).toContain("fatal: repository 'https://***@github.com/o/r.git/' not found")
    expect(msg).toContain('gh auth login')
    expect(cloneErrorMessage('fatal: unable to access: Could not resolve host: nope')).not.toContain('gh auth')
  })
})
