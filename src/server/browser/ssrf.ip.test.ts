import { describe, expect, it } from 'vitest'
import { classifyIp, isLoopbackOrUnspecified } from './ssrf.ip'

const PRIVATE = [
  '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
  '169.254.169.254', '100.64.0.1', '100.127.255.255', '198.18.0.1', '224.0.0.1', '255.255.255.255',
  '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
  '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::127.0.0.1',
  '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1', '2001::1', 'not-an-ip', '', '999.1.1.1',
]
const PUBLIC = ['8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
  '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808']

describe('classifyIp', () => {
  it.each(PRIVATE)('private: %s', (ip) => expect(classifyIp(ip)).toBe('private'))
  it.each(PUBLIC)('public: %s', (ip) => expect(classifyIp(ip)).toBe('public'))
})

describe('isLoopbackOrUnspecified', () => {
  it.each(['127.0.0.1', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1'])('true: %s', (ip) => expect(isLoopbackOrUnspecified(ip)).toBe(true))
  it.each(['10.0.0.1', '8.8.8.8', '2606:4700::1', 'x'])('false: %s', (ip) => expect(isLoopbackOrUnspecified(ip)).toBe(false))
})
