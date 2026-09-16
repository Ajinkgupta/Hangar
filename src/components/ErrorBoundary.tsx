import { Component, type ReactNode } from "react";

type State = { error: Error | null };

/** Last line of defence: show the error and a reload button instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h2>Hangar hit an error</h2>
        <pre>{String(this.state.error.stack || this.state.error.message)}</pre>
        <p className="hint">Your terminals keep running in the background daemon. Reload to reattach.</p>
        <button className="primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
