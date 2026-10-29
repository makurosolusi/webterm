import { Component, type ErrorInfo, type ReactNode } from 'react'

// React catches render/lifecycle errors only in a class boundary — there is no hook equivalent in
// React 19. Without one, a single thrown error unmounts the whole tree and the page goes blank (the
// crypto.randomUUID crash did exactly that). Show what broke and a way back instead of a black screen.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Uncaught render error:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    // Inline styles on purpose: this must render even if the stylesheet is the thing that failed.
    return (
      <div
        role="alert"
        style={{
          position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24,
          background: '#16181d', color: '#e6e6e6', fontFamily: 'system-ui, sans-serif', textAlign: 'center',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Something broke</h1>
        <pre
          style={{
            margin: 0, maxWidth: 560, maxHeight: '40vh', overflow: 'auto', whiteSpace: 'pre-wrap',
            padding: '10px 14px', borderRadius: 8, background: '#0f1115', color: '#ff9a9a',
            fontSize: 13, fontFamily: 'ui-monospace, monospace',
          }}
        >
          {error.message}
        </pre>
        <button
          onClick={() => location.reload()}
          style={{
            padding: '8px 18px', borderRadius: 8, border: '1px solid #3a3f4b',
            background: '#272b33', color: '#e6e6e6', cursor: 'pointer', fontSize: 14,
          }}
        >
          Reload
        </button>
      </div>
    )
  }
}
