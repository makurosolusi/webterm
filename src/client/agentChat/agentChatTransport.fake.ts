// test-only: a fake AgentChatTransport whose stream the test drives (emit / status), shared by the view tests.
import { act } from '@testing-library/react'
import { vi } from 'vitest'
import type { ChatStreamStatus } from '../chat/chatTypes'
import type { AgentChatCommand, AgentChatConfig, AgentChatEvent, AgentChatModel, AgentChatRewindResult, AgentChatSessionSummary } from '../../shared/agentChat.wire'
import type { AgentChatStreamOptions, AgentChatTransport } from './agentChatTransport'

export function fakeAgentChatTransport() {
  let opts: AgentChatStreamOptions | null = null
  const close = vi.fn()
  const t = {
    stream: vi.fn((o: AgentChatStreamOptions) => { opts = o; return { close } }),
    send: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    setMode: vi.fn(async () => undefined),
    history: vi.fn(async () => ({ items: [], next: null })),
    toolResult: vi.fn(async () => ''),
    upload: vi.fn(async (_f: File, name: string) => `/data/agent-chat-uploads/n1/x-${name}`),
    imageUrl: (ref: string) => `/api/agent-chat/n1/history?image=${ref}`,
    catalog: vi.fn(async (): Promise<AgentChatCommand[]> => []),
    models: vi.fn(async (): Promise<AgentChatModel[]> => []),
    setConfig: vi.fn(async (_patch: Partial<AgentChatConfig>) => undefined),
    sessions: vi.fn(async (): Promise<AgentChatSessionSummary[]> => []),
    resume: vi.fn(async (_sessionId: string) => undefined),
    newConversation: vi.fn(async () => undefined),
    rewind: vi.fn(async (_id: string, _dryRun: boolean): Promise<AgentChatRewindResult> => ({ canRewind: true, filesChanged: ['/w/a.ts'], insertions: 2, deletions: 1 })),
    fork: vi.fn(async (_id: string, _text: string) => undefined),
    stopTask: vi.fn(async (_id: string) => undefined),
  } satisfies AgentChatTransport
  /** Opens the stream (if not yet) and delivers `events`. */
  const emit = (...events: AgentChatEvent[]): void => act(() => {
    opts?.onStatus('open')
    for (const e of events) opts?.onEvent(e)
  })
  const status = (st: ChatStreamStatus): void => act(() => opts?.onStatus(st))
  return { t, emit, close, status }
}

/** An `init` event with every field filled. */
export const initEvent = (seq: number, sessionId: string, extra: Partial<Extract<AgentChatEvent, { t: 'init' }>> = {}): AgentChatEvent =>
  ({ seq, t: 'init', sessionId, model: 'claude-x', mode: 'default', commands: [], capabilities: [], cliVersion: '1', cwd: '/w', ...extra })
