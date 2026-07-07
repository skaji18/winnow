import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { AddItem } from "./components/AddItem.js";
import { ConfirmHost } from "./components/ConfirmDialog.js";
import { HeaderCounts } from "./components/HeaderCounts.js";
import { ProjectsView } from "./components/Projects.js";
import { QueueView } from "./components/QueueView.js";
import { SessionsView } from "./components/SessionsView.js";
import { SettingsView } from "./components/SettingsView.js";
import { SprintsView } from "./components/Sprints.js";
import { TreeView } from "./components/TreeView.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { LiveContext } from "./live.js";
import type { AppState } from "./types.js";

type Tab = "queue" | "sprints" | "projects" | "backlog" | "sessions" | "settings";

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>("queue");
  const [error, setError] = useState<string | null>(null);
  const [liveMsg, setLiveMsg] = useState("");

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000); // §4 自動分の進捗を映す軽いポーリング
    return () => clearInterval(t);
  }, [refresh]);

  // サーバ再起動の自動検知: bootId(プロセス毎の識別子)が変わったら再読込する。再起動で
  // ローカルシークレットが再生成され、開きっぱなしタブの変更系が 403 になるため
  // (自己更新の適用後は必ずここを通って新しい index.html + シークレットを取り直す)。
  // dev (シークレット未注入=Vite:5174) では発火しない: tsx watch の再起動毎に bootId が
  // 変わり、保護すべきシークレットも無いのに編集中の画面状態を吹き飛ばしてしまう。
  const bootIdRef = useRef<string | null>(null);
  useEffect(() => {
    const injected = (globalThis as unknown as { __WINNOW_SECRET__?: string }).__WINNOW_SECRET__;
    const id = state?.bootId;
    if (!injected || !id) return;
    if (bootIdRef.current === null) bootIdRef.current = id;
    else if (bootIdRef.current !== id) location.reload();
  }, [state?.bootId]);

  if (!state) {
    return (
      <div className="app">
        <p className="muted">読み込み中…{error && ` (${error})`}</p>
      </div>
    );
  }

  const togglePause = async () => {
    await api.updateSettings({ pauseAuto: !state.settings.pauseAuto });
    setLiveMsg(state.settings.pauseAuto ? "自動実行を再開しました" : "自動実行を一時停止しました");
    await refresh();
  };

  return (
    <LiveContext.Provider value={setLiveMsg}>
      <ConfirmHost>
      <div className="app">
        <a className="skip-link" href="#main">
          本文へスキップ
        </a>
        {/* 操作結果用の単一 aria-live status (視覚非表示)。 */}
        <div className="sr-only" role="status" aria-live="polite">
          {liveMsg}
        </div>

        <header className="top">
          <h1>Winnow</h1>
          <span className="tagline">判断アテンションを配給する道具</span>
          <HeaderCounts state={state} />
          <button
            className="pause-toggle"
            aria-pressed={state.settings.pauseAuto}
            title="自動実行の一時停止(承認は通せます)"
            onClick={togglePause}
          >
            {state.settings.pauseAuto ? "▶ 自動実行を再開" : "⏸ 自動実行を一時停止"}
          </button>
          <span className="summary-line" title="ループを閉じて見せる (§4-5)">
            {state.summary.line}
          </span>
        </header>

        <nav className="tabs" role="tablist" aria-label="ビュー">
          {(
            [
              ["queue", `キュー (${state.queue.length})`],
              ["sprints", `スプリント (${state.sprints.length})`],
              ["projects", `案件 (${state.projects.length})`],
              ["backlog", "バックログ"],
              ["sessions", `セッション (${state.sessions.length})`],
              ["settings", "再調律・設定"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              id={`tab-${t}`}
              role="tab"
              aria-selected={tab === t}
              aria-controls="main"
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* preflight トップバナー: AI 未接続→セッション起動。未提供(undefined)なら何も出さない。 */}
        {state.preflight && !state.preflight.ok && (
          <div className="cold-banner danger" role="alert">
            AI 未接続: {state.preflight.reason ?? "接続を確認できません"} →{" "}
            <button
              onClick={() =>
                api.initAi().then(refresh).catch((e) => setError((e as Error).message))
              }
            >
              セッション起動
            </button>
          </div>
        )}

        {/* 自己更新バナー: 新版検知→ワンタップ適用 (server updater.ts)。未提供なら何も出さない。 */}
        {state.update && (
          <UpdateBanner update={state.update} version={state.version} onChange={refresh} />
        )}

        {error && <div className="cold-banner">通信エラー: {error}</div>}

        {/* どこからでも即キャプチャ (新規儀式ゼロ §4)。全タブ共通の登録口。 */}
        <AddItem state={state} onChange={refresh} />

        <main id="main" tabIndex={-1}>
          {tab === "queue" && <QueueView state={state} onChange={refresh} />}
          {tab === "sprints" && <SprintsView state={state} onChange={refresh} />}
          {tab === "projects" && <ProjectsView state={state} onChange={refresh} />}
          {tab === "backlog" && <TreeView state={state} onChange={refresh} />}
          {tab === "sessions" && <SessionsView state={state} onChange={refresh} />}
          {tab === "settings" && <SettingsView state={state} onChange={refresh} />}
        </main>
      </div>
      </ConfirmHost>
    </LiveContext.Provider>
  );
}
