// Persistent per-node host divs: node content is portaled into them and they are moved between the
// canvas slot and a tab pane without being re-created.
const hosts = new Map<string, HTMLDivElement>()

export function getNodeHost(id: string): HTMLDivElement {
  let host = hosts.get(id)
  if (!host) {
    host = document.createElement('div')
    host.className = 'tab-host'
    hosts.set(id, host)
  }
  return host
}

export function placeNodeHost(id: string, parent: Element | null): void {
  const host = getNodeHost(id)
  if (parent === null) return void host.remove()
  if (host.parentNode === parent) return
  // moveBefore keeps iframes loaded and focus intact; appendChild would reload them.
  const mv = (parent as Element & { moveBefore?: (n: Node, ref: Node | null) => void }).moveBefore
  if (typeof mv === 'function' && host.isConnected) mv.call(parent, host, null)
  else parent.appendChild(host)
}

export function releaseNodeHost(id: string): void {
  hosts.get(id)?.remove()
  hosts.delete(id)
}
