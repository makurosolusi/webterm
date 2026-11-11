/**
 * Runs `fn` once the page has finished loading, so a never-ending request (EventSource) started at
 * mount does not keep the browser tab's loading spinner spinning forever. Returns a cancel function.
 */
export function afterPageLoad(fn: () => void): () => void {
  if (typeof document === 'undefined' || document.readyState === 'complete') {
    fn()
    return () => {}
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  // The next macrotask after `load`: the load indicator settles before the stream opens.
  const onLoad = (): void => { timer = setTimeout(fn, 0) }
  window.addEventListener('load', onLoad, { once: true })
  return () => {
    window.removeEventListener('load', onLoad)
    if (timer !== null) clearTimeout(timer)
  }
}
