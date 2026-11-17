// "Public web page" check for read-only research by a locked agent (skill-author): http(s) to a public host only.
// Reuses the navigation guard (scheme, userinfo, localhost, private/link-local/metadata IP literals, no allowlist,
// no loopback exception); DNS-level rebinding and redirects stay with the egress proxy and the frame guard.
import { createNavigationGuard } from './navigation.guard'

const guard = createNavigationGuard({ allow: new Set(), webtermPort: 0 })

/** True when `raw` is an absolute http(s) URL to a non-local, non-private host without credentials. */
export const isPublicWebUrl = (raw: unknown): boolean => typeof raw === 'string' && guard.check(raw).ok
