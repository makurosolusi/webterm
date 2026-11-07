/** Suspense fallback for a lazily loaded pane: the codicon spinner the app already uses for pending work. */
export function LazyPaneFallback(): React.JSX.Element {
  return <span className="codicon codicon-loading codicon-modifier-spin" role="status" aria-label="Loading" />
}
