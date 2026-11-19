import { describe, expect, it } from 'vitest'
import { detectSecrets, type SecretScan } from './secretMask.detect'
import { MAX_SCAN_CHARS } from './secretMask.patterns'

// All credentials below are fabricated fixtures (test-only), built by concatenation
// so no scanner mistakes this file for a real leak.
const GH_TOKEN = 'ghp_' + 'a1B2c3D4'.repeat(5) // test-only
const SK_TOKEN = 'sk-' + 'proj1234567890abcdefXYZ' // test-only
const JWT = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'c2lnbmF0dXJlMTIz' // test-only

/** Exact range of the first occurrence of `secret` in `text`. */
const at = (text: string, secret: string, kind: string) => {
  const from = text.indexOf(secret)
  expect(from).toBeGreaterThanOrEqual(0)
  return { from, to: from + secret.length, kind }
}
const secrets = (text: string, scan: SecretScan): string[] => scan.ranges.map((r) => text.slice(r.from, r.to))

describe('file-wide by name', () => {
  it.each([
    'a/b/server.pem', 'x.key', 'bundle.p12', 'bundle.PFX', 'home/.ssh/id_rsa', 'id_ed25519',
    'id_ecdsa', 'id_rsa_work', 'credentials.json', 'cfg/service-account-prod.json',
    'service-account.json', '.netrc', '/home/u/.pgpass', 'kubeconfig', 'C:\\k\\kubeconfig',
  ])('hides %s entirely', (path) => {
    expect(detectSecrets(path, 'anything')).toEqual({ fileWide: true, ranges: [], truncated: false })
  })

  it.each(['id_rsa.pub', 'id_ed25519.pub', 'keys.json', 'monkey.ts', 'credentials.md', 'readme.md'])(
    'does not hide %s by name', (path) => {
      expect(detectSecrets(path, 'plain text').fileWide).toBe(false)
    })
})

describe('file-wide by content', () => {
  it.each(['RSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PRIVATE KEY', 'ENCRYPTED PRIVATE KEY'])(
    'detects a %s block', (label) => {
      const text = `notes\n-----BEGIN ${label}-----\nMIIB\n-----END ${label}-----\n`
      const scan = detectSecrets('notes.txt', text)
      expect(scan).toEqual({ fileWide: true, ranges: [], truncated: false })
    })

  it('ignores a public key block', () => {
    expect(detectSecrets('a.txt', '-----BEGIN PUBLIC KEY-----\nMIIB\n').fileWide).toBe(false)
  })
})

describe('key/value pairs', () => {
  it('masks .env style values with exact offsets', () => {
    const text = 'API_KEY=abcdef123456\nOTHER=1\nexport DB_PASSWORD=hunter22 # prod\n'
    const scan = detectSecrets('config.sh', text)
    expect(scan.ranges).toEqual([
      at(text, 'abcdef123456', 'key-value'),
      at(text, 'hunter22', 'key-value'),
    ])
  })

  it('masks YAML values and honours quotes', () => {
    const text = 'client_secret: "s3cr3t value"\nauth: \'abc123xyz\'\npasswd: plainpass\n'
    const scan = detectSecrets('app.yaml', text)
    expect(scan.ranges).toEqual([
      at(text, 's3cr3t value', 'key-value'),
      at(text, 'abc123xyz', 'key-value'),
      at(text, 'plainpass', 'key-value'),
    ])
  })

  it('masks JSON values, several pairs per line, and camelCase names', () => {
    const text = '{"apiKey": "k-123456", "name": "x", "accessToken": "tok_abcdef", "port": 8000}'
    const scan = detectSecrets('c.json', text)
    expect(scan.ranges).toEqual([at(text, 'k-123456', 'key-value'), at(text, 'tok_abcdef', 'key-value')])
  })

  it('matches every listed key family case-insensitively', () => {
    const names = ['apikey', 'Api-Key', 'MY_SECRET', 'gh_token', 'pwd_PASSWORD', 'DB_PASSWD', 'private_key',
      'AWS_ACCESS_KEY', 'client_secret', 'AUTH_HEADER', 'credential_blob']
    for (const n of names) {
      const text = `${n}=value-${n}-9`
      expect(secrets(text, detectSecrets('x.conf', text)), n).toEqual([`value-${n}-9`])
    }
  })

  it('does not treat author as auth', () => {
    expect(detectSecrets('package.json', '{"author": "Jane Roe"}').ranges).toEqual([])
  })

  it('masks only the first line of a YAML block scalar', () => {
    const text = 'private_key: |\n  line-one-of-key\n  line-two-of-key\nname: x\n'
    const scan = detectSecrets('c.yaml', text)
    // Documented limit: continuation lines after the first content line stay visible.
    expect(scan.ranges).toEqual([at(text, 'line-one-of-key', 'key-value')])
  })

  it('handles CRLF line endings', () => {
    const text = 'TOKEN=abcd1234\r\nNAME=x\r\n'
    expect(detectSecrets('a.conf', text).ranges).toEqual([at(text, 'abcd1234', 'key-value')])
  })

  it('masks a commented-out assignment', () => {
    const text = '# API_KEY=realvalue99\n'
    expect(detectSecrets('a.conf', text).ranges).toEqual([at(text, 'realvalue99', 'key-value')])
  })
})

describe('known token prefixes', () => {
  it('masks tokens anywhere, even in prose', () => {
    const text = `see ${GH_TOKEN} and "${SK_TOKEN}" plus ${JWT}.`
    const scan = detectSecrets('notes.md', text)
    expect(scan.ranges).toEqual([
      at(text, GH_TOKEN, 'token'), at(text, SK_TOKEN, 'token'), at(text, JWT, 'token'),
    ])
  })

  it.each([
    ['sk-ant-' + 'api03-abcdefghijklmnop1234'],
    ['gho_' + 'Z9y8X7w6'.repeat(5)],
    ['github_pat_' + '11ABCDEFG0abcdefghij1234'],
    ['AKIA' + 'IOSFODNN7EXAMPLE'],
    ['xoxb-' + '1234567890-abcdefghij'],
    ['glpat-' + 'abcdefghij1234567890'],
    ['AIza' + 'SyA-abcdefghijklmnopqrstuvwxyz01234'.slice(0, 35)],
    ['npm_' + 'a1b2c3d4e5'.repeat(3) + 'abcdef'],
    ['SG.' + 'abcdefghijklmnop' + '.' + 'qrstuvwxyz012345'],
  ])('recognises %s', (token) => {
    const text = `value ${token} end`
    expect(detectSecrets('f.txt', text).ranges).toEqual([at(text, token, 'token')])
  })

  it('does not match a prefix glued to a longer word', () => {
    expect(detectSecrets('f.txt', 'risk-assessment-for-the-whole-quarter').ranges).toEqual([])
  })
})

describe('connection strings', () => {
  it('masks only the password', () => {
    const text = 'url: postgres://admin:p4ssw0rd@db.internal:5432/app\n'
    expect(detectSecrets('c.yaml', text).ranges).toEqual([at(text, 'p4ssw0rd', 'connection-string')])
  })

  it('leaves credential-less and placeholder URLs alone', () => {
    const text = 'a: https://example.com/x\nb: postgres://u:${DB_PASS}@h/db\nc: redis://h:6379\n'
    expect(detectSecrets('c.yaml', text).ranges).toEqual([])
  })
})

describe('.env files', () => {
  it('masks every value, even with an unknown key', () => {
    const text = 'FOO=bar123\nPORT=3000\nNAME="Jane Roe"\n# note\nEMPTY=\n'
    const scan = detectSecrets('/p/.env', text)
    expect(scan.ranges).toEqual([at(text, 'bar123', 'env-value'), at(text, 'Jane Roe', 'env-value')])
  })

  it('applies to .env.* variants but not templates', () => {
    const text = 'FOO=bar123\n'
    expect(detectSecrets('.env.production', text).ranges).toHaveLength(1)
    expect(detectSecrets('.env.local', text).ranges).toHaveLength(1)
    for (const t of ['.env.example', '.env.sample', '.env.template']) {
      expect(detectSecrets(t, text).ranges, t).toEqual([])
    }
  })

  it('still masks only the quoted content and keeps inline comments visible', () => {
    const text = "KEY='abc def' # why\nOTHER=zzz9 # because\n"
    expect(secrets(text, detectSecrets('.env', text))).toEqual(['abc def', 'zzz9'])
  })
})

describe('negatives', () => {
  it('ignores a key merely mentioned in prose', () => {
    const text = '# Set LAYA_API_KEY in your shell before starting.\nSet LAYA_API_KEY in the environment.\n'
    expect(detectSecrets('README.md', text).ranges).toEqual([])
  })

  it('ignores the compose default for a non-secret variable', () => {
    expect(detectSecrets('compose.yaml', '  LAYA_PORT: ${LAYA_PORT:-8000}\n').ranges).toEqual([])
  })

  it.each([
    'API_KEY=${API_KEY}', 'API_KEY=$API_KEY', 'API_KEY=<your-key>', 'API_KEY=changeme', 'API_KEY=CHANGEME',
    'API_KEY=xxx', 'API_KEY=***', 'API_KEY=...', 'API_KEY=', 'API_KEY=""', 'API_KEY=your-api-key',
    'API_KEY: null', 'TOKEN=true', 'TOKEN: false', 'max_tokens: 4096', 'PASSWORD=${DB:-}',
    'token: process.env.TOKEN', 'const token = getToken();', 'password: req.body.password',
    'token: string', 'auth: Bearer something here',
  ])('does not flag %s', (line) => {
    expect(detectSecrets('f.conf', line).ranges, line).toEqual([])
  })

  it('documents the prose false positive on a secret-named key', () => {
    const line = 'password: required'
    expect(secrets(line, detectSecrets('f.conf', line))).toEqual(['required'])
  })

  it('flags nothing in empty text', () => {
    expect(detectSecrets('a.txt', '')).toEqual({ fileWide: false, ranges: [], truncated: false })
  })
})

describe('ranges', () => {
  it('are sorted, non-overlapping and merge a token inside a key/value', () => {
    const text = `TOKEN=${GH_TOKEN}\nurl: postgres://u:pw99@h/x\nAPI_KEY=zz991\n`
    const { ranges } = detectSecrets('a.conf', text)
    expect(ranges.map((r) => text.slice(r.from, r.to))).toEqual([GH_TOKEN, 'pw99', 'zz991'])
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].from).toBeGreaterThanOrEqual(ranges[i - 1].to)
  })

  it('merges overlap between the .env rule and a connection string', () => {
    const text = 'DB=postgres://u:pw99@h/x\n'
    const { ranges } = detectSecrets('.env', text)
    expect(ranges).toHaveLength(1)
    expect(text.slice(ranges[0].from, ranges[0].to)).toBe('postgres://u:pw99@h/x')
  })
})

describe('limits and performance', () => {
  it('scans only the head of an oversized file and reports truncated', () => {
    const head = 'API_KEY=headsecret1\n'
    const tail = 'API_KEY=tailsecret1\n'
    const text = head + 'x'.repeat(MAX_SCAN_CHARS) + '\n' + tail
    const scan = detectSecrets('big.conf', text)
    expect(scan.truncated).toBe(true)
    expect(scan.ranges).toEqual([at(text, 'headsecret1', 'key-value')])
  })

  it('handles many lines of a large file quickly', () => {
    const text = 'FOO=bar\nTOKEN=value12345\n'.repeat(30_000)
    const t0 = performance.now()
    const scan = detectSecrets('big.conf', text)
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(scan.ranges).toHaveLength(30_000)
    expect(scan.truncated).toBe(text.length > MAX_SCAN_CHARS)
  })

  const hostile: Array<[string, string]> = [
    ['long token run', 'sk-' + 'a'.repeat(MAX_SCAN_CHARS)],
    ['repeated jwt prefix', 'eyJ'.repeat(300_000)],
    ['dash chain', 'a-'.repeat(500_000)],
    ['dotted key run', 'a.'.repeat(500_000)],
    ['quote storm', '"\'"\''.repeat(200_000)],
    ['unclosed var refs', '${'.repeat(500_000)],
    ['scheme run', 'a+'.repeat(500_000) + '://'],
    ['key without separator', 'token'.repeat(200_000)],
    ['colons', 'k:'.repeat(500_000)],
    ['private key opener', '-----BEGIN '.repeat(90_000)],
  ]
  it.each(hostile)('stays linear on %s', (_name, text) => {
    const t0 = performance.now()
    detectSecrets('x.conf', text)
    detectSecrets('.env', text)
    expect(performance.now() - t0).toBeLessThan(3000)
  })

  it('survives pseudo-random input with a bounded time', () => {
    let seed = 42
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0)
    const alphabet = 'aZ09_-.:="\' \t\n\r#$@/{}|>skeyJ'
    let text = ''
    for (let i = 0; i < 400_000; i++) text += alphabet[next() % alphabet.length]
    const t0 = performance.now()
    const scan = detectSecrets('.env.local', text)
    expect(performance.now() - t0).toBeLessThan(3000)
    for (const r of scan.ranges) {
      expect(r.from).toBeGreaterThanOrEqual(0)
      expect(r.to).toBeLessThanOrEqual(text.length)
      expect(r.to).toBeGreaterThan(r.from)
    }
  })
})
