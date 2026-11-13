import { Component, type ErrorInfo, type ReactNode } from "react"
import { RotateCw, TriangleAlert } from "lucide-react"

/** Keeps one broken view from taking down the whole shell. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label ?? "view"}]`, error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="max-w-md rounded-md border border-st-error/35 bg-st-error-tint px-4 py-3 text-xs">
          <div className="flex items-center gap-2 font-medium text-st-error-fg">
            <TriangleAlert size={14} /> {this.props.label ?? "This view"} crashed
          </div>
          <pre className="mt-2 max-h-32 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-fg-muted">{this.state.error.message}</pre>
          <button className="mt-2 flex h-6 items-center gap-1 rounded-sm border border-line px-2 text-fg hover:bg-hover" onClick={() => this.setState({ error: null })}>
            <RotateCw size={12} /> Reload view
          </button>
        </div>
      </div>
    )
  }
}
