# Canvas containment: nothing leaves the canvas except by an explicit, labelled act

## Principle

webterm's own UI runs in the user's browser. So any `window.open`, `<a target="_blank">` or `location` change in client
code opens a tab or window in the machine's Chrome, and the server process can reach the same browser through the OS
opener (`open`, `xdg-open`, `explorer.exe`). The owner's rule: everything started from the canvas stays on the canvas.
A tab or window in the machine browser appears only when the user clicks an action labelled "Open in system browser"
(or copies the link). Failure never falls back silently to the machine browser; it shows a notice that offers the
explicit action.

## Legitimate exits (the whole list)

| Exit | Where | Why it is allowed |
| --- | --- | --- |
| "Open in system browser" | `openInSystemBrowser` in `src/client/canvasLinks.ts` (the only `window.open`) | The user's click on a labelled action is conscious consent. Reached from the browser node menu and from the notice shown when the canvas browser cannot take a link. |
| Full-size attached image | `chat/chatMessageRow.tsx`, `agentChat/agentChatThread.tsx` (`target="_blank"`) | `data:` or same-origin server URL, never an external page. |
| Sign-in window of webterm itself | `src/server/uiOpen.ts` | Opens webterm's own redirect file (a path) so the user can reach the UI; guarded by `assertPathArg`. |
| Reveal in file manager | `src/server/workspaceCreate/projectsFolder.ts` | `open -R` / `xdg-open` on a folder, a path, not a page; guarded by `assertPathArg`. |
| Chromium targets of the canvas browser | `src/server/browser/*` | The canvas browser node owns its targets; its own runtime guard lives there. |

`src/shared/containment.policy.test.ts` enforces the list: outside these entries, any `window.open(`, `target="_blank"`,
`location.assign/replace/href =`, a child process naming `open`/`xdg-open`/`explorer.exe`/`start`, `shell.openExternal`,
`Target.createTarget` outside `src/server/browser/`, or the `open` npm package fails the build.

## Everything else goes through the helpers

- Client: `openLinkInCanvas(url, { openBrowserAt, anchorNodeId })` opens http(s) in a browser node. When the node is off or
  refuses, it shows a notice with "Open in system browser" and "Copy link"; non-web schemes are refused. External
  documentation anchors use `<ExternalLink href>` (`src/client/ExternalLink.tsx`). Terminal Cmd/Ctrl+click, rendered
  Markdown links, MCP App `openLink` and chat links all use this path.
- Server (terminal programs): the `open`/`xdg-open`/`webterm-open` shims capture web links into the canvas browser and
  refuse `file:` URLs and web-like files (.html/.htm/.xhtml/.svg); see `canvas-link-capture.md`.
- Server (own opener calls): arguments must be paths; `assertPathArg` (`src/server/openArgGuard.ts`) throws on a URL.

## Browser node context menu

Chromium (headful, offscreen) shows its NATIVE context menu for a forwarded right click, and "Open link in new
tab/window" from it creates a target with no opener: a tab on the user's machine. The native menu must never appear.
Source closed, not only the effect (the runtime guard in `browserHost.containment.ts` stays as the last net):

- **The right button is never forwarded.** `BrowserHost.input` passes every mouse event through
  `ctxMenu.intercept` (`browserHost.contextMenu.ts`); right down/up end there. The host hit-tests the point with
  `Runtime.evaluate` (`elementFromPoint`, same-origin iframes entered), after giving the site a synthetic cancelable
  `contextmenu` event: a site that cancels it (Figma, Docs) keeps its own menu and webterm shows nothing. Otherwise the
  client gets `contextMenu` and draws its own menu (`src/client/browserContextMenu/`, shared `VscodeMenu`: role menu,
  arrows/Enter/Esc, focus returns).
- **Backstop script** (`BACKSTOP_SCRIPT`, `Page.addScriptToEvaluateOnNewDocument` on every page we create): bubble-phase
  `contextmenu` (keyboard menu key, Shift+F10), `auxclick` button 1 and Ctrl/Cmd+click on a link are cancelled unless the
  page already did, so Chromium opens neither its menu nor a tab. Middle and Ctrl/Cmd+click are still forwarded (sites
  with their own middle-button pan keep working); the host hit-tests and opens a link under the pointer as a tab of the
  node (`tabApi.newTab`, same guard/tab-limit as popups).
- **No CDP binding.** `Runtime.bindingCalled` is delivered only with Runtime enabled, which the host keeps off (anti-bot
  detectable). Results come back as `Runtime.evaluate` return values, so there is no binding name for a page to forge.
- **The page is untrusted.** The hit-test answer goes through `sanitizeContext` (`src/shared/browser.contextmenu.ts`):
  http/https only, address and text capped, selection sent as a boolean (never its text), `data:` images dropped;
  hit-tests are limited to `CTX_RATE_MAX` per `CTX_RATE_WINDOW_MS` per node. The client action "Open link in new tab"
  (`openLink`) is validated by the wire parser and again in `ctxMenu.openLink`.
- **Menu rows** (all inside the canvas): link: Open link in new tab, Copy link address; image: Copy image address;
  selection / editable: Copy, Cut, Paste; page: Back, Forward, Reload. "Open in system browser" is NOT in this menu: the
  only legitimate exit stays the explicit action in the toolbar's ⋮ menu. Right click on the tab strip / toolbar is
  unchanged (it is not the page's).
- **Limits.** A right click inside a cross-origin iframe gets the page-level menu (a synthetic event cannot cross the
  origin, and the iframe's own custom menu does not see it). Synthetic `contextmenu` has `isTrusted=false`. Not provable
  without a real Chromium: that the backstop listener cancels Chromium's own middle/Ctrl+click tab open (known platform
  behaviour of `preventDefault` on `auxclick`/`click`); if it did not, the containment guard still moves the stray page
  into a tab, and that tab can then appear twice. Save image is not offered (no download path for it exists).

## Window surfacing is banned

No CDP command may raise, focus or move an OS window of the user's machine. Node windows are deliberately minimized on
macOS (`windowPlacement`), and `Target.activateTarget`, `Page.bringToFront` and `Browser.setWindowBounds` un-minimize and
focus the real window. They are refused at the single send point (`CdpClient.send` via `cdp.windowGuard.ts`, so the agent
allowlist is covered too), and `Target.createTarget` is only allowed as `newWindow` + `background` + `focus:false`.
`windowSurfacing.policy.test.ts` fails if any browser source names a banned method. A page that Chromium reports as not
attached (-32000) is therefore never "activated": the node is lost or the tab marked crashed and the user gets Reload.

## Adding a new exit

Do not. First route the feature through the helpers above. If a real exit is unavoidable (a native integration, a new
OS call):

1. Write why the canvas cannot do it and how the user consents (a labelled click).
2. Put the call in one small file, guard its argument, add a test that a URL or hostile input is refused.
3. Add one entry to `ALLOW` in `src/shared/containment.policy.test.ts` with the path and the reason. Never widen an entry
   or allow a whole folder to make a test pass.
4. Add a row to the table above.

## Checklist for a new feature

- Does any link, button or anchor point at a page outside webterm? Use `openLinkInCanvas` / `ExternalLink`.
- Does the server start a process that may open a browser (OS opener, `$BROWSER`, an OAuth helper)? Capture it or refuse it.
- Does any failure path fall back to `window.open` or the OS opener? Replace it with a notice.
- Did you run `src/shared/containment.policy.test.ts` (it is in the `test:impacted` policy tier)?

## Limits

Static scanning cannot see a URL passed through a variable to an allowlisted call, a program that calls the OS opener by
absolute path, or a Chromium runtime flag; the runtime guard in `src/server/browser/*` and the shims cover those
(see `canvas-link-capture.md` "What cannot be caught").

## Managed browser binary

The Browser node never uses a browser installed on the user's machine (Chrome, Chromium, Brave, Edge, Playwright or
Puppeteer caches). An installed browser is the user's daily app: it shares the app identity, can appear or take focus on
the desktop, and shares OS handlers (default-browser, URL schemes), which breaks the canvas containment above.

webterm owns its Chrome instead: a version-locked **Chrome for Testing** (`CHROME_FOR_TESTING_VERSION` in
`src/server/browser/chromium.managed.ts`), an app named "Google Chrome for Testing" with its own identity. Resolution
order in `chromium.launch.ts`:

1. `WEBTERM_BROWSER_BIN`, only when the user sets it (a missing file is an error, never a fallback).
2. `<data dir>/browser/chrome-for-testing/<version>/...` when present.
3. Otherwise downloaded once (HTTPS, size and time capped, zip-slip safe extraction) into 2, then used.

The setup wizard's "Download Chromium" calls the same install (`browserDownload.ts` wraps `ensureManaged`): one path, locked
version, pinned SHA-256, and it never writes `WEBTERM_BROWSER_BIN`. Network failures retry automatically (bounded, growing
pauses) and restart clean (the archive is held in memory, nothing partial on disk); a checksum mismatch is refused, not retried.
`bun scripts/fetch-chrome.ts --dest <dir>` does the same by hand. `CHROME_SHA256` pins each platform archive; Chrome for
Testing publishes no checksums, so a bump regenerates them with `--print-sha256` and confirms against an independent download.
