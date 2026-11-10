// Checkpoint wiring follows the armed CA2 handle per turn: the cached service may be resolved before arming.
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { setActiveCa2 } from './central/ca2Active'
import { CHECKPOINT_FLAG } from './central/context/contextAssembler'
import { freshDb } from './central/guard/controlGuard.testutil'
import { type ChatService, resolveChatService } from './centralChatHandlers'

const SETTLE_MS = 50
const previousFlag = process.env[CHECKPOINT_FLAG]
let db: Database
let chat: ChatService
let sent = 0

const memory = { block: () => ({ text: '', items: [], truncated: false }) }
const arm = (): void => setActiveCa2({ db, memory } as never)
const checkpoints = (): number => (db.query('SELECT COUNT(*) AS n FROM central_checkpoint').get() as { n: number }).n

async function turn(): Promise<void> {
  sent += 1
  await chat.service.submit({ conversationId: 'central:global', clientMessageId: `arming-${sent}`, text: `message ${sent}` }).done
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

beforeEach(() => {
  process.env[CHECKPOINT_FLAG] = 'on'
  db = freshDb()
  chat = resolveChatService({}, db, 'mock')
})
afterEach(() => {
  setActiveCa2(null)
  if (previousFlag === undefined) delete process.env[CHECKPOINT_FLAG]
  else process.env[CHECKPOINT_FLAG] = previousFlag
})

it('a service resolved before arming writes a checkpoint once armed', async () => {
  arm()
  await turn()
  expect(checkpoints()).toBeGreaterThan(0)
})

it('a disarmed service stops summarizing on the next turn', async () => {
  arm()
  await turn()
  const armedRows = checkpoints()
  expect(armedRows).toBeGreaterThan(0)
  setActiveCa2(null)
  await turn()
  expect(checkpoints()).toBe(armedRows)
})

it('re-arming takes effect on the next turn, with the same handle or a new one', async () => {
  const handle = { db, memory } as never
  setActiveCa2(handle)
  await turn()
  const first = checkpoints()
  setActiveCa2(null)
  await turn()
  setActiveCa2(handle)
  await turn()
  const second = checkpoints()
  expect(second).toBe(first + 1)
  setActiveCa2(null)
  arm()
  await turn()
  expect(checkpoints()).toBe(second + 1)
})

it('a handle armed on another database leaves this service unwired', async () => {
  setActiveCa2({ db: freshDb(), memory } as never)
  await turn()
  expect(checkpoints()).toBe(0)
})
