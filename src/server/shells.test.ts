import { describe, expect, it } from 'vitest'
import { installedShells } from './shells'

describe('installedShells', () => {
  it('lists existing shells from /etc/shells, $SHELL first, without comments or duplicates', () => {
    const present = new Set(['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish'])
    const shells = installedShells({
      etcShells: () => '# List of acceptable shells\n/bin/bash\n/bin/zsh\n/bin/csh\n\n/bin/zsh\n',
      exists: (p) => present.has(p),
      envShell: '/opt/homebrew/bin/fish',
    })
    expect(shells).toEqual(['/opt/homebrew/bin/fish', '/bin/bash', '/bin/zsh'])
  })

  it('is empty when /etc/shells is unreadable and $SHELL is unset (Windows)', () => {
    expect(installedShells({ etcShells: () => null, exists: () => true, envShell: undefined })).toEqual([])
  })
})
