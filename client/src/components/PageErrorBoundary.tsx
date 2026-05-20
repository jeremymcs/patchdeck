import { Component, type ErrorInfo, type ReactNode } from "react";

type PageErrorBoundaryProps = {
  pageName: string;
  children: ReactNode;
};

type PageErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

export class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  state: PageErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: unknown): PageErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page runtime error", {
      pageName: this.props.pageName,
      error,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <div className="w-full max-w-2xl border border-destructive/40 bg-destructive/10 p-4 text-body text-destructive">
            <div className="text-label uppercase tracking-wider text-destructive/80">Page runtime error</div>
            <div className="mt-2 text-title text-foreground">{this.props.pageName}</div>
            <pre className="mt-3 whitespace-pre-wrap break-words text-body">{this.state.message || "Unknown render error"}</pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-md border border-destructive/50 px-3 py-1 text-label font-medium uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
