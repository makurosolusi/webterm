/**
 * Embedding port for the third hybrid-memory leg (closes TODO ca2-08) and its offline default.
 * Embeddings are for memory/conversation text only, never code (PLAN/rnd/03 §2: agentic grep beats
 * code RAG). The default is a dependency-free hashed character-trigram embedder: it runs offline and
 * catches typos and word-form variants the FTS legs miss (`deploymnt` vs `deploy`), but it is lexical,
 * not semantic.
 * ponytail: lexical vectors only; plug a real model (Voyage API, or transformers.js once a ~300 MB
 * onnxruntime-node is acceptable) behind `Embedder` when synonym recall matters.
 */

/** Sync embedder: one L2-normalised vector of `dim` per input text. */
export interface Embedder {
  readonly modelId: string
  readonly dim: number
  embed(texts: readonly string[]): Float32Array[]
}

export const LOCAL_EMBED_MODEL = 'local-trigram-v1'
export const LOCAL_EMBED_DIM = 512
const MAX_WORDS = 400

/** 32-bit FNV-1a. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function embedOne(text: string, dim: number): Float32Array {
  const vec = new Float32Array(dim)
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, MAX_WORDS)
  for (const word of words) {
    const padded = `#${word}#`
    for (let i = 0; i + 3 <= padded.length; i += 1) vec[fnv1a(padded.slice(i, i + 3)) % dim]! += 1
  }
  let norm = 0
  for (const v of vec) norm += v * v
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm)
    for (let i = 0; i < dim; i += 1) vec[i]! *= inv
  }
  return vec
}

/** The offline default embedder. */
export const localEmbedder: Embedder = {
  modelId: LOCAL_EMBED_MODEL,
  dim: LOCAL_EMBED_DIM,
  embed: (texts) => texts.map((t) => embedOne(t, LOCAL_EMBED_DIM)),
}

/** Cosine of two L2-normalised vectors (their dot product); 0 when the dims differ. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!
  return dot
}
