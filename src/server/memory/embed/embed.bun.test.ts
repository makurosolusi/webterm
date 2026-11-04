// Bun-only (bun:sqlite). Embedding leg of hybrid memory retrieval + embed_cache + prefetch. No model API is called:
// the default embedder is the offline trigram one, failures are simulated with a throwing fake.
import { expect, test } from 'bun:test'
import { searchMemoryHybrid } from '../memoryHybrid'
import { T0, fixture, same, seedRow } from '../memoryV2.fixture'
import { embedTexts, prefetchMemoryEmbeddings } from './embedCache'
import { cosine, localEmbedder, type Embedder } from './embedLocal'

const GLOBAL = { projectId: null }
const keys = (db: ReturnType<typeof fixture>, query: string, embedder?: Embedder | null) =>
  searchMemoryHybrid(db, { viewer: GLOBAL, query, now: T0, ...(embedder === undefined ? {} : { embedder }) }).map((h) => h.record.key)

function counting(): Embedder & { texts: number } {
  const e = { modelId: localEmbedder.modelId, dim: localEmbedder.dim, texts: 0, embed(t: readonly string[]) { e.texts += t.length; return localEmbedder.embed(t) } }
  return e
}

function seeded() {
  const db = fixture()
  seedRow(db, { key: 'proc.deploy', body: 'Deploy to staging through the release script', scope: 'global', kind: 'procedure' })
  seedRow(db, { key: 'pref.theme', body: 'Prefers the solarized dark theme everywhere', scope: 'global', kind: 'preference' })
  return db
}

test('the embedding leg finds a typo query both FTS legs miss', () => {
  const db = seeded()
  same(keys(db, 'deploymnt relese', null), [])
  same(keys(db, 'deploymnt relese'), ['proc.deploy'])
})

test('unrelated text stays below the similarity floor', () => {
  const db = seeded()
  same(keys(db, 'nothingmatches'), [])
  const [a, b] = localEmbedder.embed(['release script', 'release script'])
  expect(Math.abs(cosine(a!, b!) - 1) < 1e-6).toBe(true)
})

test('a failing embedder degrades to the lexical legs instead of throwing', () => {
  const db = seeded()
  const broken: Embedder = { modelId: 'broken', dim: 8, embed: () => { throw new Error('offline') } }
  same(keys(db, 'staging', broken), keys(db, 'staging', null))
  same(keys(db, 'deploymnt relese', broken), [])
})

test('embed_cache: the same text is embedded once per model', () => {
  const db = seeded()
  const e = counting()
  embedTexts(db, e, ['alpha beta', 'alpha   BETA', 'gamma'], T0)
  expect(e.texts).toBe(2)
  const again = embedTexts(db, e, ['gamma', 'alpha beta'], T0 + 1)
  expect(e.texts).toBe(2)
  expect(Math.abs(cosine(again[1]!, localEmbedder.embed(['alpha beta'])[0]!) - 1) < 1e-6).toBe(true)
})

test('prefetch warms memory vectors so a search only embeds the query', () => {
  const db = seeded()
  const e = counting()
  expect(prefetchMemoryEmbeddings(db, e, T0)).toBe(2)
  expect(e.texts).toBe(2)
  same(keys(db, 'deploymnt relese', e), ['proc.deploy'])
  expect(e.texts).toBe(3)
})
