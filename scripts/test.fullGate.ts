// Gate for `npm test` / `npm run test:bun`: the full suites run only through `test:all` /
// `test:bun:all` (owner) or with WEBTERM_FULL_TESTS=1 (CI). Exit 2 otherwise.
import { FULL_SUITE_MESSAGE, fullTestsOpen } from './testGuard.decide'

if (!fullTestsOpen(process.env)) {
  console.error(FULL_SUITE_MESSAGE)
  process.exit(2)
}
