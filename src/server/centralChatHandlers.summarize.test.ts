// Production wiring of F5-c: a CA2-armed Central chat service gets the model summarizer factory
// (`createCentralSummarize`), an unarmed one none. The factory is mocked, so no model is ever reached.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Summarize } from './central/context/checkpointSummarizer'
import { openFixture, type Fixture } from './central/centralTestFixture.testutil'
import { setActiveCa2 } from './central/ca2Active'

const fake: Summarize = async () => ({ narrative: 'fake' })
const factory = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./central/context/checkpointLlm', () => ({ createCentralSummarize: () => { factory.calls += 1; return fake } }))
const { resolveChatService } = await import('./centralChatHandlers')

let fixture: Fixture
beforeEach(() => { fixture = openFixture(); factory.calls = 0 })
afterEach(() => { setActiveCa2(null); fixture.close() })

const summarizeOf = (s: { service: unknown }): unknown => (s.service as { summarize?: unknown }).summarize

it('armed Central uses the LLM summarizer factory', () => {
  setActiveCa2({ db: fixture.db, memory: { block: () => ({ text: '', items: [], truncated: false }) } } as never)
  const chat = resolveChatService({ now: () => 1 }, fixture.db, 'mock')
  expect(factory.calls).toBe(1)
  expect(summarizeOf(chat)).toBe(fake)
})

it('unarmed Central writes no checkpoint summary', () => {
  const chat = resolveChatService({ now: () => 1 }, fixture.db, 'mock')
  expect(factory.calls).toBe(0)
  expect(summarizeOf(chat)).toBeUndefined()
})
