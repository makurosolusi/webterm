// REST calls of the downloads UI (`/api/browser/:nodeId/downloads/*`, same session cookie as every browser call).
import { BROWSER_REST_PREFIX } from '../../shared/browser.contract'
import { request } from '../browser.api'

const seg = encodeURIComponent
const base = (nodeId: string): string => `/${seg(nodeId)}/downloads`

export const cancelDownload = (nodeId: string, id: string) => request<void>('POST', `${base(nodeId)}/${seg(id)}/cancel`)
export const keepDownload = (nodeId: string, id: string) => request<void>('POST', `${base(nodeId)}/${seg(id)}/keep`)
/** Removes the entry AND deletes its file (the list is the only handle on the file). */
export const removeDownload = (nodeId: string, id: string) => request<void>('DELETE', `${base(nodeId)}/${seg(id)}`)
export const downloadPath = async (nodeId: string, id: string): Promise<string> => (await request<{ path: string }>('GET', `${base(nodeId)}/${seg(id)}/path`)).path

/** URL whose answer is an attachment: opening it makes the person's own browser ask where to save the copy. */
export const downloadFileUrl = (nodeId: string, id: string): string => `${BROWSER_REST_PREFIX}${base(nodeId)}/${seg(id)}/file`

/** Start the save of a copy through a temporary link: the browser UI (not the server) writes the file wherever the person picks. */
export function saveCopy(nodeId: string, id: string, name: string): void {
  const a = document.createElement('a')
  a.href = downloadFileUrl(nodeId, id)
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
