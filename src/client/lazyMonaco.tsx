import type * as Monaco from 'monaco-editor'
import { createTsWorkerReaper } from './tsWorkerReaper'
import { defineWebtermThemes } from './monacoTheme'
import { getBrowserWorkspace } from './browser.stream'
import * as fsClient from './fsClient'
import { LSP_WS_PATH } from './editorLsp.client'

/**
 * Monaco di-muat MALAS, satu kali, lewat dynamic import.
 *
 * Monaco berukuran beberapa MB JS. Mengimpornya statis menaruhnya di chunk awal setiap kali app
 * dibuka — termasuk board yang isinya cuma terminal dan tidak punya node editor sama sekali.
 * `loadMonaco()` adalah batas chunk-nya: Rollup memisahkan seluruh pohon di dalam fungsi async ini,
 * dan ia baru diunduh saat node editor pertama benar-benar mount.
 *
 * Promise-nya di-memo, jadi node editor kedua memakai instance yang sama (Monaco memang modul
 * global: tema, model, dan worker-nya dibagi satu proses).
 */

export type MonacoApi = typeof Monaco

let pending: Promise<MonacoApi> | null = null

export function loadMonaco(): Promise<MonacoApi> {
  pending ??= (async () => {
    // `?worker` adalah dukungan web worker bawaan Vite: tiap entri jadi chunk worker tersendiri
    // yang diserve dari origin app (satu port, middleware mode) — tanpa CDN, tanpa konfigurasi
    // di vite.config.ts.
    //
    // KENAPA MonacoEnvironment MASIH PERLU di 0.57: WorkerManager Monaco memang punya fallback
    // `createWorker: () => new Worker(new URL('ts.worker.js', import.meta.url), { type: 'module' })`,
    // tapi referensi itu hidup DI DALAM node_modules dan tidak dilewati plugin worker Vite, jadi
    // yang terjadi adalah "Failed to load worker script for label: editorWorkerService". Karena
    // `getWorker(descriptor)` memeriksa `globalThis.MonacoEnvironment` LEBIH DULU
    // (esm/vs/internal/common/workers.js), menyediakannya di sini membuat fallback itu tak pernah
    // terpakai.
    //
    // Path specifier-nya SENGAJA tanpa prefiks `esm/vs`: sejak 0.56 exports map monaco memetakan
    // `"./*" -> "./esm/vs/*.js"`, jadi path dalam gaya lama `monaco-editor/esm/vs/...` jadi dobel
    // prefiks dan gagal resolve.
    // The LSP bridge and chord forwarding only act on Monaco, so they ride in its chunk too.
    const [monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker, { wireEditorLsp }, { forwardEditorChords }] = await Promise.all([
      import('monaco-editor'),
      import('monaco-editor/editor/editor.worker.js?worker'),
      import('monaco-editor/language/json/json.worker.js?worker'),
      import('monaco-editor/language/css/css.worker.js?worker'),
      import('monaco-editor/language/html/html.worker.js?worker'),
      import('monaco-editor/language/typescript/ts.worker.js?worker'),
      import('./editorLsp.monaco'),
      import('./editorChords'),
    ])

    self.MonacoEnvironment = {
      getWorker(_workerId: string, label: string) {
        if (label === 'json') return new jsonWorker.default()
        if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker.default()
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker.default()
        if (label === 'typescript' || label === 'javascript') return new tsWorker.default()
        return new editorWorker.default()
      }
    }

    defineWebtermThemes(monaco)
    wireTsWorkerReaper(monaco)
    // App chords (tab layout, rebound commands) must reach the app from inside every editor; follows rebinding live.
    forwardEditorChords(monaco)
    // Language servers (hover, go-to-definition, rename...) for editor-node models; see editorLsp.monaco.ts.
    wireEditorLsp(monaco, {
      // The workspace this tab serves (App sets it for the browser socket too).
      workspaceId: getBrowserWorkspace,
      open: (workspace, language) => new WebSocket(lspWsUrl(workspace, language)),
      readMeta: fsClient.readMeta,
      writeChecked: fsClient.writeChecked,
    })
    return monaco
  })()
  return pending
}

function lspWsUrl(workspace: string, language: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // No credential in the URL: the same-origin upgrade carries the `wt_ui` session cookie.
  const q = [`workspace=${encodeURIComponent(workspace)}`, `language=${language}`].join('&')
  return `${proto}://${location.host}${LSP_WS_PATH}?${q}`
}

/**
 * Worker TS/JS tidak pernah idle sendiri di Monaco 0.57 — lihat `tsWorkerReaper.ts` untuk bukti
 * di source Monaco dan mekanisme mematikannya. `monaco.typescript` adalah namespace 0.57;
 * `monaco.languages.typescript` di sana cuma stub usang.
 */
function wireTsWorkerReaper(monaco: MonacoApi): void {
  const defaults = {
    typescript: monaco.typescript.typescriptDefaults,
    javascript: monaco.typescript.javascriptDefaults
  } as const
  const reaper = createTsWorkerReaper({
    liveLanguageIds: () => monaco.editor.getModels().map((m) => m.getLanguageId()),
    stopWorker: (language) => {
      // Kick no-op: setCompilerOptions menyalakan onDidChange, yang memanggil _stopWorker().
      const d = defaults[language]
      d.setCompilerOptions(d.getCompilerOptions())
    }
  })
  // Model yang sudah ada sebelum ini jalan (hari ini: tidak ada, modul inilah yang memuat Monaco)
  // akan terlewat — seed dari daftar hidup supaya reaper tidak pernah kurang hitung.
  for (const model of monaco.editor.getModels()) reaper.modelEntered(model.getLanguageId())
  monaco.editor.onDidCreateModel((model) => reaper.modelEntered(model.getLanguageId()))
  monaco.editor.onWillDisposeModel((model) => reaper.modelLeft(model.getLanguageId()))
  monaco.editor.onDidChangeModelLanguage(({ model, oldLanguage }) => {
    reaper.modelLeft(oldLanguage)
    reaper.modelEntered(model.getLanguageId())
  })
}
