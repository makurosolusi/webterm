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

function move(host: HTMLDivElement, parent: Element): void {
  if (host.parentNode === parent) return
  // moveBefore keeps iframes loaded and focus intact; appendChild would reload them.
  const mv = (parent as Element & { moveBefore?: (n: Node, ref: Node | null) => void }).moveBefore
  if (typeof mv === 'function' && host.isConnected) mv.call(parent, host, null)
  else parent.appendChild(host)
}

export function placeNodeHost(id: string, parent: Element | null): void {
  const host = getNodeHost(id)
  if (parent === null) return void host.remove()
  move(host, parent)
}

// Always-mounted hidden element: a host parks here while its pane unmounts so it never leaves the document.
let parking: Element | null = null
export function setParkingEl(el: Element | null): void { parking = el }

/** Moves a live host into the parking element (no-op if the node has no host or nothing is mounted to park in). */
export function parkNodeHost(id: string): void {
  const host = hosts.get(id)
  if (host && parking?.isConnected) move(host, parking)
}

export function releaseNodeHost(id: string): void {
  hosts.get(id)?.remove()
  hosts.delete(id)
}
