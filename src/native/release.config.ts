// Where the native app looks for updates: the public folder that holds the files `npm run release:native`
// collects (the `stable-macos-arm64-update*.json` manifests, `.tar.zst` bundles and `.patch` files), e.g.
// 'https://<your host>/webterm'. Set it here, in source: electrobun.config.ts bakes it into the build
// (release.baseUrl), so a build only checks the host it was made for. Empty = updates are not configured:
// the app never checks, and Hutch generates no patches.
export const UPDATE_BASE_URL = ''
