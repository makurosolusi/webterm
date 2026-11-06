// Lock (agent-211-C8): the open inbox list is keyset-paged, so an item past the first page (the
// list used to stop at 200 with no way further) is reachable through the cursor.
import { expect, test } from 'bun:test'
import { freshDb, T0 } from '../central/guard/controlGuard.testutil'
import { INBOX_PAGE_MAX, createInboxItem } from './inboxItemStore'
import { inboxListRoute } from './inboxItemRoute'

const OVERFLOW = 7

function setup() {
  const clock = { t: T0 }
  const ctx = { db: freshDb(), now: () => clock.t }
  return { ctx, clock }
}

type Page = { items: { id: string; kind: string }[]; nextCursor: string | null }
const list = (s: ReturnType<typeof setup>, query = '') => inboxListRoute({ ctx: s.ctx }, new URL(`http://x/api/approvals/inbox${query}`))

test('201st open item is reachable via cursor', () => {
  const s = setup()
  const ids: string[] = []
  // Pairs share a created_at, so the id tie-break of the keyset is exercised as well.
  for (let n = 0; n < INBOX_PAGE_MAX + OVERFLOW; n++) {
    s.clock.t = T0 + Math.floor(n / 2)
    ids.push(createInboxItem(s.ctx, { kind: 'notify', source: 'agent', title: `Item ${n}` }).id)
  }
  createInboxItem(s.ctx, { kind: 'question', source: 'agent', title: 'Ranked first' })

  const first = list(s)
  expect(first.status).toBe(200)
  const p1 = first.body as Page
  expect(p1.items).toHaveLength(INBOX_PAGE_MAX)
  expect(p1.items[0]?.kind).toBe('question')
  expect(p1.nextCursor).toEqual(expect.any(String))

  const second = list(s, `?cursor=${encodeURIComponent(p1.nextCursor ?? '')}`)
  expect(second.status).toBe(200)
  const p2 = second.body as Page
  expect(p2.nextCursor).toBeNull()
  const seen = [...p1.items, ...p2.items].map((i) => i.id)
  expect(new Set(seen).size).toBe(seen.length)
  for (const id of ids) expect(seen).toContain(id)
  expect(seen).toContain(ids[INBOX_PAGE_MAX])
})

test('limit pages through every item exactly once', () => {
  const s = setup()
  for (let n = 0; n < 11; n++) createInboxItem(s.ctx, { kind: n % 2 ? 'review' : 'notify', source: 'agent', title: `Item ${n}` })
  const seen: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const res = list(s, `?limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`)
    expect(res.status).toBe(200)
    const page = res.body as Page
    seen.push(...page.items.map((i) => i.id))
    cursor = page.nextCursor
    pages++
  } while (cursor !== null && pages < 10)
  expect(seen).toHaveLength(new Set(seen).size)
  expect(pages).toBe(Math.ceil(seen.length / 3))
  expect(seen.length >= 11).toBe(true)
})

test('a malformed cursor or limit is a 400, not a 500 or a silent first page', () => {
  const s = setup()
  expect(list(s, '?cursor=not-a-cursor').body).toMatchObject({ error: 'invalid_cursor' })
  expect(list(s, `?cursor=${Buffer.from('[1,"x","id"]').toString('base64url')}`).status).toBe(400)
  expect(list(s, '?limit=0').body).toMatchObject({ error: 'invalid_limit' })
  expect(list(s, `?limit=${INBOX_PAGE_MAX + 1}`).status).toBe(400)
  expect(list(s, '?limit=2.5').status).toBe(400)
})
