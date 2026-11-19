// Download webterm's locked Chrome for Testing: `bun scripts/fetch-chrome.ts --dest <dir>` prints the binary path.
// `--print-sha256` prints "<platform> <sha256>" for every platform (to fill CHROME_SHA256 after checking the values).
import { resolve } from 'node:path'
import { archiveSha256, CHROME_FOR_TESTING_VERSION, installManaged } from '../src/server/browser/chromium.managed'
import type { CftPlatform } from '../src/server/browser/chromium.managed'

const PLATFORMS: CftPlatform[] = ['mac-arm64', 'mac-x64', 'linux64', 'win64']
const args = process.argv.slice(2)
const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }

async function main(): Promise<void> {
  if (args.includes('--print-sha256')) {
    console.error(`# Chrome for Testing ${CHROME_FOR_TESTING_VERSION}: verify against a second, independent download before pinning`)
    for (const p of PLATFORMS) console.log(`${p} ${await archiveSha256(p)}`)
    return
  }
  const dest = flag('--dest')
  if (!dest) throw new Error('usage: bun scripts/fetch-chrome.ts --dest <dir> | --print-sha256')
  console.log(await installManaged(resolve(dest)))
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.message}${e.cause instanceof Error ? ` (${e.cause.message})` : ''}` : e)
  process.exit(1)
})
