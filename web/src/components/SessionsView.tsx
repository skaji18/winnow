import { useState } from "react";
import { api } from "../api.js";
import { TerminalPane } from "./TerminalPane.js";
import type { AppState } from "../types.js";

// ---------------------------------------------------------------------------
export function SessionsView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [sel, setSel] = useState<string | null>(state.sessions[0]?.name ?? null);
  const [initing, setIniting] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  const init = async () => {
    setIniting(true);
    setInitError(null);
    try {
      await api.initAi();
      await onChange();
    } catch (e) {
      setInitError((e as Error).message);
    } finally {
      setIniting(false);
    }
  };

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>セッション（tmux常駐のclaude）</h3>
        <button disabled={initing} onClick={init}>
          {initing ? "起動中…" : "セッションを起動 / 再確認"}
        </button>
      </div>
      {initError && (
        <div className="cold-banner" role="alert">
          セッション起動に失敗しました: {initError}
        </div>
      )}
      {state.sessions.length === 0 ? (
        <p className="muted">
          セッション未起動。「セッションを起動」を押すとtmuxにcontrol/workerのclaudeを常駐させます。
        </p>
      ) : (
        <div className="sessions-grid">
          <div className="session-list">
            {state.sessions.map((s) => (
              <button
                key={s.name}
                className={sel === s.name ? "sel" : ""}
                onClick={() => setSel(s.name)}
              >
                <span className={`dot ${s.busy ? "busy" : "idle"}`} />
                {s.name.replace("winnow:", "")}
                <div className="muted" style={{ fontSize: 11 }}>
                  {s.role} {s.currentLabel ? `· ${s.currentLabel}` : "· 待機"}
                </div>
              </button>
            ))}
          </div>
          <TerminalPane session={sel} />
        </div>
      )}
    </div>
  );
}
