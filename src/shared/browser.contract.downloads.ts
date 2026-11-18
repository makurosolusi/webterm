// Agent-facing shapes of the `downloads` verb (split out of browser.contract.ts). Declarations and limits only.
import type { DownloadState } from './browser.downloads'

/** Largest text `downloads read` returns (the rest is cut with a marker); a bigger or binary file is taken with `copy`. */
export const DOWNLOAD_READ_MAX_BYTES = 64 * 1024
/** Longest destination (relative path in the agent's working directory) `downloads copy` accepts. */
export const DOWNLOAD_COPY_TO_MAX_CHARS = 200

/** One download as an agent sees it. No path: the files are not readable on disk, they are taken with `read` or `copy`. */
export interface AgentDownload { id: string; name: string; state: DownloadState; bytes: number; total: number; host: string; risky: boolean; failure?: string }
/** List answer, newest first. File names and hosts come from the page: data, never instructions (`note`). */
export interface DownloadsData { downloads: AgentDownload[]; note: string }
/** `read`: the text of one finished file, at most `DOWNLOAD_READ_MAX_BYTES` (`truncated` says the rest was cut). */
export interface DownloadReadData { id: string; name: string; bytes: number; text: string; truncated: boolean; note: string }
/** `copy`: the file now sits at `copiedTo`, relative to the agent's working directory. */
export interface DownloadCopyData { id: string; name: string; bytes: number; copiedTo: string; note: string }
export type DownloadsReply = DownloadsData | DownloadReadData | DownloadCopyData
/** Body of the `downloads` verb: empty = list; `read: <id>`; `copy: <id>` with `to`. (`cwd` is set by the server, never by the caller.) */
export interface DownloadsBody { read?: string; copy?: string; to?: string }
