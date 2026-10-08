import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../lib/reportError';

interface Props {
  /** Where this boundary sits, for the report (e.g. "rail:chat"). */
  where: string;
  /** What to show instead of the crashed children; `retry` re-renders them. */
  fallback: (retry: () => void, error: Error) => ReactNode;
  /** Changing this clears the error (e.g. switching to another tab). */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  error: Error | null;
  key: unknown;
}

/**
 * Catches a render crash in its children so one broken panel can't blank the whole page
 * (React unmounts everything on an uncaught render error), and reports it to the server.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, this.props.where, info.componentStack);
  }

  render() {
    if (this.state.error) return this.props.fallback(() => this.setState({ error: null }), this.state.error);
    return this.props.children;
  }
}

/** Small in-place fallback for a panel. */
export function PanelError({ retry, what }: { retry: () => void; what: string }) {
  return (
    <div className="notice stack" role="alert">
      <p style={{ margin: 0 }}>The {what} hit a problem. The rest of the room (and your music) is still running.</p>
      <div className="row">
        <button className="btn" onClick={retry}>
          Try again
        </button>
      </div>
    </div>
  );
}
