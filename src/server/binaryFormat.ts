// Executable format sniffing by header bytes only: a binary is READ (first KiB), never run. Tells a
// macOS Mach-O apart from a Linux ELF so "envman" built for the host is not launched inside Docker.
import { closeSync, openSync, readSync } from 'node:fs'
import type { CustomCommandCompat, CustomCommandFormat } from '../shared/customCommands'

export interface BinaryInfo {
  format: CustomCommandFormat
  /** Target OS of a compiled binary; absent for scripts and unknown files. */
  os?: 'darwin' | 'linux' | 'windows'
  /** Architectures inside (a universal Mach-O lists several), in webterm naming: arm64 | amd64. */
  archs: string[]
}

const HEADER_BYTES = 1024
const MACHO_CPU: Record<number, string> = { 0x0100000c: 'arm64', 0x01000007: 'amd64' }
const ELF_MACHINE: Record<number, string> = { 0xb7: 'arm64', 0x3e: 'amd64' }
const PE_MACHINE: Record<number, string> = { 0xaa64: 'arm64', 0x8664: 'amd64' }
/** A fat Mach-O header and a Java class file share 0xcafebabe; fat counts are tiny, class versions are not. */
const FAT_MAX_ARCHS = 20

function readHeader(path: string): Buffer | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(HEADER_BYTES)
    return buf.subarray(0, readSync(fd, buf, 0, HEADER_BYTES, 0))
  } catch {
    return null // unreadable: reported as unknown, never as incompatible
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Format of the file at `path` from its header. Never executes it. */
export function sniffBinary(path: string): BinaryInfo {
  const b = readHeader(path)
  const unknown: BinaryInfo = { format: 'unknown', archs: [] }
  if (!b || b.length < 4) return unknown
  if (b[0] === 0x23 && b[1] === 0x21) return { format: 'script', archs: [] }
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) { // ELF: e_machine at 18, endianness at 5
    const machine = b.length >= 20 ? (b[5] === 2 ? b.readUInt16BE(18) : b.readUInt16LE(18)) : 0
    return { format: 'elf', os: 'linux', archs: ELF_MACHINE[machine] ? [ELF_MACHINE[machine]] : [] }
  }
  const magic = b.readUInt32BE(0)
  if (magic === 0xcafebabe && b.length >= 8 && b.readUInt32BE(4) <= FAT_MAX_ARCHS) {
    const n = b.readUInt32BE(4)
    const archs: string[] = []
    for (let i = 0; i < n && 8 + i * 20 + 4 <= b.length; i++) { const a = MACHO_CPU[b.readUInt32BE(8 + i * 20)]; if (a) archs.push(a) }
    return { format: 'macho', os: 'darwin', archs }
  }
  if (magic === 0xfeedfacf || magic === 0xfeedface) return { format: 'macho', os: 'darwin', archs: arch(MACHO_CPU[b.readUInt32BE(4)]) }
  if (magic === 0xcffaedfe || magic === 0xcefaedfe) return { format: 'macho', os: 'darwin', archs: arch(MACHO_CPU[b.readUInt32LE(4)]) }
  if (b[0] === 0x4d && b[1] === 0x5a) { // PE: "MZ", e_lfanew at 0x3c -> "PE\0\0" + machine
    const pe = b.length >= 0x40 ? b.readUInt32LE(0x3c) : 0
    const ok = pe > 0 && pe + 6 <= b.length && b.readUInt32BE(pe) === 0x50450000
    return { format: 'pe', os: 'windows', archs: ok ? arch(PE_MACHINE[b.readUInt16LE(pe + 4)]) : [] }
  }
  return unknown
}
const arch = (a: string | undefined): string[] => (a ? [a] : [])

/** webterm naming for this machine: `darwin`/`linux`/`windows` and `arm64`/`amd64`. */
export const hostPlatform = (platform: string = process.platform, a: string = process.arch): { os: string; arch: string } =>
  ({ os: platform === 'win32' ? 'windows' : platform, arch: a === 'x64' ? 'amd64' : a })

/** Folder name for this machine, e.g. `linux-arm64`: the per-platform subfolder convention. */
export const platformDirName = (platform?: string, a?: string): string => { const h = hostPlatform(platform, a); return `${h.os}-${h.arch}` }

const OS_LABEL: Record<string, string> = { darwin: 'macOS', linux: 'Linux', windows: 'Windows' }

/** ok | wrong_platform | wrong_arch | unknown. Scripts are portable; Apple Silicon also runs amd64 (Rosetta). */
export function compatOf(info: BinaryInfo, platform?: string, a?: string): CustomCommandCompat {
  if (info.format === 'script') return 'ok'
  if (!info.os) return 'unknown'
  const host = hostPlatform(platform, a)
  if (info.os !== host.os) return 'wrong_platform'
  if (info.archs.length === 0 || info.archs.includes(host.arch)) return 'ok'
  return host.os === 'darwin' && info.archs.includes('amd64') ? 'ok' : 'wrong_arch'
}

/** Actionable text for an incompatible binary; null when it is fine or unknown. */
export function incompatMessage(name: string, info: BinaryInfo, platform?: string, a?: string): string | null {
  const c = compatOf(info, platform, a)
  if (c !== 'wrong_platform' && c !== 'wrong_arch') return null
  const host = hostPlatform(platform, a)
  const have = `${OS_LABEL[info.os as string]} ${info.archs.join('/') || ''}`.trim()
  return `${name} is a ${have} binary; this machine is ${host.os}/${host.arch} — add a ${host.os}-${host.arch} build next to it`
}

/** Header-based verdict for the file at `path`. */
export function inspectBinary(name: string, path: string, platform?: string, a?: string): { format: CustomCommandFormat; compat: CustomCommandCompat; message: string | null } {
  const info = sniffBinary(path)
  return { format: info.format, compat: compatOf(info, platform, a), message: incompatMessage(name, info, platform, a) }
}
