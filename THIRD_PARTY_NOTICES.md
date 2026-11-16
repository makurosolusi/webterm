# Third-Party Notices

webterm includes portions of the following third-party software.

## Orca

- Repository: https://github.com/stablyai/orca
- License: MIT
- Source ported: `src/shared/browser-url.ts` (`normalizeBrowserNavigationUrl`, `looksLikeSearchQuery`, `buildSearchUrl`, search engine table) at commit `7d6603aa1766eb4cac079f8d6d2f4e67f251574a`
- Used in webterm:
  - `src/shared/browser.omnibox.ts` (address bar / omnibox input resolution)
  - `src/shared/browser.omnibox.test.ts` (test cases adapted from `src/shared/browser-url.test.ts`)
- Source ported: `src/main/browser/cookies/browser-cookie-import-policy.ts` (`GOOGLE_SOURCE_BOUND_COOKIE_NAMES`, `normalizeCookieDomain`, `NON_TRANSPLANTABLE_DOMAINS` / `isNonTransplantableCookieDomain`, `isGoogleSourceBoundCookie`) and the Google filter order of `browser-cookie-import-pipeline.ts` (`importValidatedCookies`) at commit `68ba160c12c0ad443cf8e24c19d496c0d46fcd62`
- Used in webterm:
  - `src/server/browser/cookieImportPolicy.ts` (Google login cookies are skipped on cookie file import)
  - `src/server/browser/cookieImportPolicy.test.ts` (test cases adapted from `browser-cookie-import-policy.test.ts`)

```
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Terminal colour schemes

The palettes in `src/client/themes.ts` refer to the published colours of the following openly
licensed schemes. The colour values were rewritten for webterm and no scheme source code is
included; a few values (for example the Tokyo Night bright colours and some Solarized bright colours)
are not guaranteed to match the published ones exactly. Licences were checked at the repositories
named below.

| Scheme | Repository | Licence |
| --- | --- | --- |
| VS Code terminal defaults, Dark/Light Modern | https://github.com/microsoft/vscode | MIT, Copyright (c) 2015 - present Microsoft Corporation |
| Dracula | https://github.com/dracula/dracula-theme | MIT, Copyright (c) 2023 Dracula Theme |
| Nord | https://github.com/nordtheme/nord | MIT, Copyright (c) 2016-present Sven Greb |
| Solarized | https://github.com/altercation/solarized | MIT, Copyright (c) 2011 Ethan Schoonover |
| Catppuccin (Mocha, Latte) | https://github.com/catppuccin/catppuccin | MIT, Copyright (c) 2021 Catppuccin |
| Gruvbox | https://github.com/morhetz/gruvbox | MIT/X11 (as stated in its README) |
| Tokyo Night | https://github.com/folke/tokyonight.nvim | Apache License 2.0 |
| One Dark | https://github.com/atom/atom (one-dark-syntax) | MIT, Copyright (c) 2016 GitHub Inc. |
