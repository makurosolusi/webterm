/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { legacyClaudeNodeIds, useRecordLegacyClaudeProfiles } from './useLegacyClaudeProfiles'

const node = (id: string, data: Record<string, unknown>): Node => ({ id, type: 'agent', position: { x: 0, y: 0 }, data })
const NODES = [
  node('legacy', { agentId: 'claude', cmd: 'claude' }),
  node('custom', { agentId: 'claude', cmd: 'envman -e x -- claude' }),
  node('recorded', { agentId: 'claude', cmd: 'claude', claudeProfileId: 'm' }),
  node('codex', { agentId: 'codex', cmd: 'codex' }),
]
const SETTINGS = { ...DEFAULT_SETTINGS, claudeLaunchProfiles: [{ id: 'm', name: 'M', command: 'envman -e m --' }], defaultClaudeProfileId: 'm' }

describe('legacy Claude node recording', () => {
  it('only a profile-less node with the stock command is legacy', () => {
    expect(legacyClaudeNodeIds(NODES)).toEqual(['legacy'])
  })

  it('records the default profile on legacy nodes once settings are loaded', () => {
    const updateNodeData = vi.fn()
    const rf = { current: { updateNodeData } as unknown as ReactFlowInstance }
    const { rerender } = renderHook(({ hydrated }) => useRecordLegacyClaudeProfiles(NODES, hydrated, SETTINGS, rf), { initialProps: { hydrated: false } })
    expect(updateNodeData).not.toHaveBeenCalled()
    rerender({ hydrated: true })
    expect(updateNodeData).toHaveBeenCalledTimes(1)
    expect(updateNodeData).toHaveBeenCalledWith('legacy', { claudeProfileId: 'm' })
  })

  it('a stale default id records Default, the id the server launched with', () => {
    const updateNodeData = vi.fn()
    const rf = { current: { updateNodeData } as unknown as ReactFlowInstance }
    renderHook(() => useRecordLegacyClaudeProfiles(NODES, true, { ...SETTINGS, defaultClaudeProfileId: 'gone' }, rf))
    expect(updateNodeData).toHaveBeenCalledWith('legacy', { claudeProfileId: 'default' })
  })
})
