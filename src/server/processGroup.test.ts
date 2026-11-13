import { afterEach, describe, expect, it, vi } from 'vitest'
import { killProcessGroup } from './processGroup'

const fakeChild = (pid: number | undefined) => ({ pid, kill: vi.fn(() => true) })

afterEach(() => { vi.restoreAllMocks() })

describe('killProcessGroup', () => {
  it.each([undefined, 0, -0, Number.NaN])('pid %s never reaches process.kill (kill(0) = our own group)', (pid) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(pid)
    killProcessGroup(child)
    expect(kill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('a real pid signals its group, not the leader alone', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(4242)
    killProcessGroup(child, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('a group that is already gone falls back to the leader', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) })
    const child = fakeChild(4242)
    killProcessGroup(child)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
