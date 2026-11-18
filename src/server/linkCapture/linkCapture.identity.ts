// Limited identity of a terminal for ONE verb: "open this URL in my canvas". A plain terminal has no node
// token on purpose (it needs no key); this scope-limited credential is an HMAC of the node id under a
// per-install key, so it opens `LINK_OPEN_PATH` for that node's own board and nothing else (auth.ts
// accepts it on that path only). Like the node token it lives in a 0600 header file, never in env/argv.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../config'
import { isSafeNodeId } from '../../shared/workspace'
import { LINK_TOKEN_HEADER } from './linkCapture.config'

const KEY_FILE = 'link-capture.key'
const SCOPE = 'link-open:'
const SEP = '.'
let cachedKey: { dir: string; key: Buffer } | undefined

/** Per-install secret (0600, created on first use). Deleting the file and restarting revokes every issued credential. */
function key(): Buffer {
  const dir = dataDir()
  if (cachedKey?.dir === dir) return cachedKey.key
  const file = join(dir, KEY_FILE)
  let secret: Buffer
  if (existsSync(file)) secret = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex')
  else {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    secret = randomBytes(32)
    writeFileSync(file, secret.toString('hex'), { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  cachedKey = { dir, key: secret }
  return secret
}

const macOf = (nodeId: string): string => createHmac('sha256', key()).update(`${SCOPE}${nodeId}`).digest('hex')

/** Header value for `nodeId`: `<mac>.<nodeId>`. */
export function linkCredential(nodeId: string): string {
  return `${macOf(nodeId)}${SEP}${nodeId}`
}

/** Node a credential was issued to, or undefined when it is malformed or the mac does not match (constant-time). */
export function linkCredentialOwner(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const at = value.indexOf(SEP)
  const nodeId = value.slice(at + 1)
  if (at <= 0 || !isSafeNodeId(nodeId)) return undefined
  const got = Buffer.from(value.slice(0, at))
  const want = Buffer.from(macOf(nodeId))
  return got.length === want.length && timingSafeEqual(got, want) ? nodeId : undefined
}

/** `<dataDir>/node-settings/<hash>.link`: hashed like the node header file (the id comes from the client, never a file name). */
export function linkHeadersPath(nodeId: string): string {
  return join(dataDir(), 'node-settings', `${createHash('sha256').update(nodeId).digest('hex').slice(0, 16)}.link`)
}

/** Write the node's link header file (0600) for `curl -H @file`; returns its path. */
export function writeLinkHeaders(nodeId: string): string {
  mkdirSync(join(dataDir(), 'node-settings'), { recursive: true, mode: 0o700 })
  const path = linkHeadersPath(nodeId)
  writeFileSync(path, `${LINK_TOKEN_HEADER}: ${linkCredential(nodeId)}\n`, { mode: 0o600 })
  return path
}

/** Remove a closed node's link header file (best effort: an orphan file is harmless). */
export function forgetLinkHeaders(nodeId: string): void {
  rmSync(linkHeadersPath(nodeId), { force: true })
}
