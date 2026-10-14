import { Component, type ErrorInfo, type ReactNode } from "react";

/* ============================================================
   ERROR BOUNDARY
   React unmounts the whole tree when a component throws while
   rendering, so one bad panel used to blank the entire page. This
   contains the failure to the panel that threw: it shows a short
   notice and a retry, and the rest of the page keeps working.
   ============================================================ */

interface Props {
  /** What failed, in a few words ("The tournament stats"). */
  label: string;
  children: ReactNode;
  /** Change this to clear the error (e.g. when the data it shows changes). */
  resetKey?: string | number | null;
}

interface State {
  failed: boolean;
  message: string;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, message: "" };

  static getDerivedStateFromError(error: unknown): State {
    return {
      failed: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false, message: "" });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div
        role="alert"
        className="rounded border-[3px] border-gray-900 bg-white p-3 text-sm text-ink"
      >
        <p className="font-mono text-xs font-bold uppercase tracking-[0.15em]">
          {this.props.label} couldn&apos;t be shown
        </p>
        <p className="mt-1 text-xs leading-5 text-muted [overflow-wrap:anywhere]">
          Something in this panel failed to draw ({this.state.message}). The
          rest of the page is unaffected.
        </p>
        <button
          type="button"
          onClick={() => this.setState({ failed: false, message: "" })}
          className="mt-2 rounded border-[2px] border-gray-900 bg-white px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] hover:bg-accentSoft"
        >
          Try again
        </button>
      </div>
    );
  }
}
