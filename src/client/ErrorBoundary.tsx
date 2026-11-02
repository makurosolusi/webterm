import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

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
    // Utility classes only: the fallback stays readable if a component stylesheet fails, though it
    // still needs the Tailwind sheet itself (the old inline styles did not).
    return (
      <div
        role="alert"
        className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-[var(--vscode-editor-background)] p-6 text-center font-sans text-[var(--vscode-foreground)]"
      >
        <h1 className="m-0 text-lg font-semibold">Something broke</h1>
        <pre className="m-0 max-h-[40vh] max-w-[560px] overflow-auto whitespace-pre-wrap rounded-[5px] border border-[var(--vscode-editorWidget-border)] bg-[var(--vscode-editorWidget-background)] px-3.5 py-2.5 font-mono text-[13px] text-[var(--vscode-errorForeground)]">
          {error.message}
        </pre>
        <Button
          type="button"
          onClick={() => location.reload()}
          className="h-6 cursor-default rounded-sm border-0 bg-[var(--vscode-button-background)] px-3 py-0 text-[13px] text-[var(--vscode-button-foreground)] shadow-none hover:bg-[var(--vscode-button-hoverBackground)]"
        >
          Reload
        </Button>
      </div>
    )
  }
}
