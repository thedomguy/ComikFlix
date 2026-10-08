import { Component, type ReactNode } from "react";

/** Catches a crash in one page (render or effect) and shows what broke instead of a blank
 *  screen; the message is what to report. Keyed by route in App, so navigating away resets it. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("ComikFlix page crashed:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <h2>Something went wrong on this page</h2>
        <p>Send this to get it fixed:</p>
        <pre>{`${error.name}: ${error.message}\n${location.hash}\n${(error.stack || "").split("\n").slice(1, 6).join("\n")}`}</pre>
        <div className="crash-actions">
          <button className="btn play" onClick={() => location.reload()}>Reload</button>
          <a className="btn info" href="#/">Go home</a>
        </div>
      </div>
    );
  }
}
