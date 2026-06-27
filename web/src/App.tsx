import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, type DecomposeOption } from "./api.js";
import {
  ArtifactChips,
  DueBadge,
  PriorityBadge,
  ProjectChip,
  parseDate,
  provisionalTitle,
} from "./components/Bits.js";
import { applyFilter, emptyFilter, FilterBar, filterIsEmpty, type FilterState } from "./components/FilterBar.js";
import { ProjectsView } from "./components/Projects.js";
import { MiniScores, ScoreBadges } from "./components/ScoreBadges.js";
import { SprintsView } from "./components/Sprints.js";
import { TerminalPane } from "./components/TerminalPane.js";
import type { AppState, Disposition, Item, Priority, QueueItem } from "./types.js";
import { DISPOSITION_LABEL, RUNG_LABEL, STATUS_LABEL } from "./types.js";

type Tab = "queue" | "sprints" | "projects" | "backlog" | "sessions" | "settings";

// 実績ゼロ(初日)判定の閾値。LabelEvent 総数がこれ未満なら cold-banner 初日を第一級表示。
const COLD_THRESHOLD = 10;

// 操作結果用の単一 aria-live status を子へ流す軽量 context (§4-1 さばきの結果を読み上げる)。
const LiveContext = createContext<(msg: string) => void>(() => {});
function useLive() {
  return useContext(LiveContext);
}

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
            <button onClick={() => api.initAi().then(refresh)}>セッション起動</button>
          </div>
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
    </LiveContext.Provider>
  );
}

// ヘッダ集計: 実行中N/承認待ちM。N>maxWorkers のとき薄く色付け(機械ブロックはしない=ナッジ §4)。
function HeaderCounts({ state }: { state: AppState }) {
  const running =
    state.inFlight?.running ?? state.items.filter((i) => i.executionStatus === "running").length;
  const proposed =
    state.inFlight?.proposed ?? state.items.filter((i) => i.executionStatus === "proposed").length;
  // 引き取り待ち K (§3.5): 実行完了・人間の受領/採用待ち。ブラウザを開けば必ず目に入るよう常時表示。
  const handoff =
    state.inFlight?.awaitingHandoff ??
    state.items.filter((i) => i.executionStatus === "awaiting_handoff").length;
  const over = running > state.settings.maxWorkers;
  return (
    <span
      className={`header-counts${over ? " over" : ""}`}
      title={over ? "実行中が worker 上限を超えています(止めはしません)" : "実行中 / 承認待ち / 引き取り待ち"}
    >
      実行中 {running} / 承認待ち {proposed} / 引き取り待ち {handoff}
    </span>
  );
}

// ---------------------------------------------------------------------------
// キュー: 火の海ではなくエスカレーションだけの短いキュー (§4)
// ---------------------------------------------------------------------------
function QueueView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [decomposeFor, setDecomposeFor] = useState<Item | null>(null);
  const [filter, setFilter] = useState<FilterState>(emptyFilter);
  const [filterOpen, setFilterOpen] = useState(false);

  // 『/』で控えめな検索バーをトグル(input/textarea 非フォーカス時のみ)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      setFilterOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visible = filterIsEmpty(filter) ? state.queue : applyFilter(state.queue, filter);
  // 実績ゼロ(初日): LabelEvent 総数 < 閾値で「学習中」を第一級表示。totalLabels 未提供なら出さない。
  const coldDay = state.totalLabels != null && state.totalLabels < COLD_THRESHOLD;
  const learning = coldDay;

  return (
    <>
      {filterOpen && (
        <FilterBar
          items={state.queue}
          projects={state.projects}
          filter={filter}
          setFilter={setFilter}
          onClose={() => {
            setFilterOpen(false);
            setFilter(emptyFilter());
          }}
        />
      )}

      {/* 実績ゼロ初日の第一級メッセージ (§4 末 Jカーブ・期待値管理)。 */}
      {coldDay && (
        <div className="cold-banner" role="note">
          今は線を学習中です。あと {Math.max(1, COLD_THRESHOLD - (state.totalLabels ?? 0))}{" "}
          件ほどさばくと、自動に倒し始めます。序盤は助ける感ゼロでも、それは境界を学んでいる音です。
        </div>
      )}

      {/* コールドスタート=Jカーブの期待値管理 (§4 末, §5) */}
      {state.autoFolded > 0 && (
        <div className="cold-banner">
          自動で畳んだ {state.autoFolded} 件はここに出していません。序盤はキューが短くなりにくいですが、
          それは境界線を学んでいる音です。
        </div>
      )}

      {visible.length === 0 ? (
        <div className="empty">
          {filterIsEmpty(filter)
            ? "キューは空です。新しいアイテムを登録すると分類されます。"
            : "絞り込み条件に一致するアイテムはありません。"}
        </div>
      ) : (
        <>
          {/* さばく場(キュー)。仕分けと処分を行う面。 */}
          {visible
            .filter((q) => q.lane !== "in_progress")
            .map((q) => (
              <QueueCard
                key={q.id}
                item={q}
                state={state}
                learning={learning}
                onChange={onChange}
                onDecompose={() => setDecomposeFor(q)}
              />
            ))}
          {/* 着手中レーン: 自分で引き取ったタスク。ここから直接「完了/手放す」で閉じられる
              (案件/スプリントのボードに乗っていなくても完了できる継ぎ目)。 */}
          {visible.some((q) => q.lane === "in_progress") && (
            <div className="lane-head" role="heading" aria-level={2}>
              <b>着手中</b>（自分で対応中。ここで完了にできます）
            </div>
          )}
          {visible
            .filter((q) => q.lane === "in_progress")
            .map((q) => (
              <QueueCard
                key={q.id}
                item={q}
                state={state}
                learning={learning}
                onChange={onChange}
                onDecompose={() => setDecomposeFor(q)}
              />
            ))}
        </>
      )}

      {decomposeFor && (
        <DecomposeModal item={decomposeFor} onClose={() => setDecomposeFor(null)} onChange={onChange} />
      )}
    </>
  );
}

function QueueCard({
  item,
  state,
  learning,
  onChange,
  onDecompose,
}: {
  item: QueueItem;
  state: AppState;
  learning: boolean;
  onChange: () => void;
  onDecompose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const live = useLive();
  // run: 操作後にカードを即消ししない(onChange でサーバの可視集合に委ね、Undo を残す)。
  // 楽観ロック競合(409)は専用文言を aria-live に出して強制再取得する。
  const run = async (fn: () => Promise<unknown>, doneMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (doneMsg) live(doneMsg);
      await onChange();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith("CONFLICT")) {
        live("他所で更新されました。最新に更新します。");
        await onChange();
      } else {
        live(`操作に失敗しました: ${msg}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const proposed = item.executionStatus === "proposed";
  const failed = item.executionStatus === "failed" || item.status === "blocked";
  // 引き取り待ち (§3.5): 実行完了・人間の受領/採用が必要。done に沈めず前面に出す。
  const handoff = item.executionStatus === "awaiting_handoff";
  // 着手中レーン (queue.ts が lane='in_progress' を計算済み): 自分で引き取って作業中。
  // 完了/手放すをここで直接出し、ボードへ行かなくてもキュー内で閉じられるようにする。
  const inProgress = item.lane === "in_progress";
  // 監査サンプルは通常アイテムと見分けがつかない (§4-3): カード枠に特別扱いを残さない。
  const autoDone = item.autoExecuted && item.executionStatus === "succeeded";
  const autoDoneGeneral = autoDone && item.domain === "general";
  // 承認待ち/引き取り待ちは前面強調を共有(専用CSSは増やさない)。
  const cls = `card${proposed || handoff ? " proposed" : ""}`;

  // general 成果物の summary/output 分離: executionSummary/Output があればそれを優先、
  // 無ければ executionResult を `summary\n\noutput` で分割(executor の連結形)。
  const [splitSummary, splitOutput] = (() => {
    if (item.executionSummary != null || item.executionOutput != null) {
      return [item.executionSummary ?? "", item.executionOutput ?? ""];
    }
    const r = item.executionResult ?? "";
    const parts = r.split(/\n\n/);
    return [parts[0] ?? "", parts.slice(1).join("\n\n")];
  })();

  return (
    <div className={cls}>
      <div className="card-head">
        <span className="card-title">{item.title}</span>
        <ScoreBadges item={item} learning={learning} />
      </div>
      <div className="badges" style={{ marginTop: 6 }}>
        <ProjectChip
          projectId={item.projectId}
          projects={state.projects}
          sprints={state.sprints}
          sprintId={item.sprintId}
        />
        <PriorityBadge priority={item.priority} />
        <DueBadge due={item.dueDate} />
      </div>
      {/* キュー一行理由はサーバの surfaceReason を優先(blocked/failed の種別を含む)。 */}
      {(item.surfaceReason || item.reason) && (
        <div className="reason">{item.surfaceReason || item.reason}</div>
      )}
      <MiniScores item={item} />

      {/* 漸進開示: 元の文脈(body)を畳んで見せる。 */}
      {item.body && (
        <details className="exec">
          <summary className="muted">元の文脈を見る</summary>
          <pre>{item.body}</pre>
        </details>
      )}

      {/* artifacts / sourceUrl のリンクチップ (read-only 痕跡)。 */}
      <ArtifactChips artifacts={item.artifacts} sourceUrl={item.sourceUrl} />

      {/* 実行結果: general は summary/output を分離表示、それ以外は連結を1ペイン。 */}
      {(item.executionResult || splitOutput) && (
        <details className="exec">
          <summary className="muted">
            {proposed ? "計画プレビュー(実行されたら何が起きるか)を見る" : "実行結果 / メモを見る"}
          </summary>
          {item.domain === "general" && splitOutput ? (
            <>
              {splitSummary && <pre className="exec-summary">{splitSummary}</pre>}
              <pre className="exec-output">{splitOutput}</pre>
            </>
          ) : (
            <pre>{item.executionResult}</pre>
          )}
          {/* 取消時の巻き戻し手順 (自動実行しない=人間ワンタップ)。 */}
          {item.rollbackPlan && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              <b>取り消し時の巻き戻し手順(自動実行しません):</b>
              <pre>{item.rollbackPlan}</pre>
            </div>
          )}
        </details>
      )}

      {/* general 成果物の出口: コピー / この指示でやり直す。 */}
      {autoDoneGeneral && (
        <GeneralOutlet item={item} run={run} busy={busy} output={splitOutput || item.executionResult || ""} />
      )}

      {/* 再浮上カード: 実行失敗/保留のワンタップ復旧 (再実行/エスカレ/却下)。 */}
      {failed && (
        <div className="actions" style={{ marginTop: 10 }}>
          <span className="badge disp-human">再浮上</span>
          <button
            className="primary"
            disabled={busy}
            onClick={() => run(() => api.execute(item.id), "再実行しました")}
          >
            再実行
          </button>
          <button
            disabled={busy}
            title="同じ種類のタスクを今後すべて要確認(エスカレ)に固定。たまっている同種も要確認に戻ります。このボタンからは戻せません(解除は設定から)"
            onClick={() => {
              if (
                !window.confirm(
                  "この種類のタスクを今後すべて要確認に固定します。たまっている同種も要確認に戻ります。このボタンからは取り消せません(解除は設定からのみ)。よろしいですか?",
                )
              )
                return;
              run(() => api.escalateCategory(item.id), "この種類を今後すべて要確認にしました");
            }}
          >
            この種類を今後すべて要確認に
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => run(() => api.action(item.id, "reject"), "却下しました")}
          >
            却下
          </button>
          {busy && <span className="spinner">実行中…</span>}
        </div>
      )}

      {/* 引き取り待ち: 実行は完了。成果物(PR/リンク等は上の ArtifactChips、詳細は実行結果)を
          人間が確認/採用(マージ等は外で)し、『受け取る』で完了へ。winnow は採用自体は実行しない。 */}
      {handoff && (
        <div className="actions" style={{ marginTop: 10 }}>
          <span className="badge disp-escalate">引き取り待ち</span>
          <button
            className="primary"
            disabled={busy}
            title="成果物を確認した。winnow 上は完了にする(マージ/送信などの採用操作は別途あなたが外で行う)"
            onClick={() => run(() => api.accept(item.id), "確認済みにしました(採用は外で)")}
          >
            確認済みにする（採用は外で）
          </button>
          <button
            className="danger"
            disabled={busy}
            title="成果物を取り消す(痕跡は履歴に残る。巻き戻し手順があれば提示)"
            onClick={() => run(() => api.cancel(item.id), "成果物を取り消しました")}
          >
            取り消す
          </button>
          {busy && <span className="spinner">実行中…</span>}
        </div>
      )}

      {/* 着手中: 自分で引き取って作業中。完了/手放すで閉じる(ボード不要の完了導線)。 */}
      {inProgress && (
        <div className="actions" style={{ marginTop: 10 }}>
          <span className="badge">着手中</span>
          <button
            className="primary"
            disabled={busy}
            title="自分で対応し終えた。完了にする"
            onClick={() => run(() => api.updateItem(item.id, { status: "done" }), "完了にしました")}
          >
            完了にする
          </button>
          <button
            disabled={busy}
            title="まだやらない。着手を取りやめてキュー(未着手)に戻す"
            onClick={() => run(() => api.updateItem(item.id, { status: "classified" }), "キューに戻しました")}
          >
            手放す（キューに戻す）
          </button>
          {busy && <span className="spinner">実行中…</span>}
        </div>
      )}

      {!autoDone && !failed && !handoff && !inProgress && (
        <div className="actions" style={{ marginTop: 10 }}>
          {proposed ? (
            // 不可逆/高ステークス: ワンタップ承認 (§3.4, §4-4)
            <>
              <span className="badge disp-escalate">承認待ち</span>
              <button
                className="primary"
                disabled={busy}
                onClick={() => run(() => api.approve(item.id), "承認して実行しました")}
              >
                承認して実行
              </button>
              <button
                className="danger"
                disabled={busy}
                title="この実行提案を取り消す(実行しない)"
                onClick={() => run(() => api.cancel(item.id), "提案を取り消しました")}
              >
                提案を取り消す
              </button>
            </>
          ) : (
            // 通常の処分=ラベル (§4-1). 監査サンプルもここに同じ形で混ざる (§4-3)。
            <>
              {item.isAudit && <span className="chip-audit muted">確認(自動処理)</span>}
              <button
                className="primary"
                disabled={busy}
                title="自分で引き取って着手する。完了は下の『着手中』レーン(または案件/スプリントのボード)で"
                onClick={() =>
                  run(() => api.action(item.id, "do"), "着手中にしました。完了は『着手中』レーンで")
                }
              >
                自分でやる（着手）
              </button>
              {item.kind === "node" ? (
                <button disabled={busy} onClick={onDecompose}>
                  分解する
                </button>
              ) : (
                <button
                  disabled={busy}
                  title="AI に実行させる(可逆なら自動着火、不可逆なら承認待ちに)"
                  onClick={() => run(() => api.execute(item.id), "AI に実行を依頼しました")}
                >
                  AIに実行させる
                </button>
              )}
              {item.kind === "node" && !item.projectId && (
                <button
                  disabled={busy}
                  title="この問いを案件(入れ物)に格上げし、サブツリーごと紐付ける"
                  onClick={() => run(() => api.toProject(item.id), "案件に昇格しました")}
                >
                  案件に昇格
                </button>
              )}
              <Reclassify itemId={item.id} current={item.disposition} run={run} />
              <button
                className="btn-ghost"
                disabled={busy}
                title="抽象度ラダーの表示を1段具体側へ。disposition/キュー順位/実行には影響せず、表示とAIの文脈ヒントだけが変わります"
                onClick={() => run(() => api.action(item.id, "demote"), "抽象度を1段下げました")}
              >
                抽象度を1段下げる
              </button>
              {/* スコープが広い操作(この1件でなく同じ種類すべての今後を永続的に変える)を視覚分離。 */}
              {item.category && (
                <span className="scope-group" role="group" aria-label="この種類すべてに適用する操作">
                  <span className="scope-sep" aria-hidden="true" />
                  <span className="scope-label">この種類すべてに:</span>
                  <button
                    disabled={busy}
                    title="同じ種類のタスクを今後すべて自動処理にし、在庫もまとめて自動実行します(設定から解除可)"
                    onClick={() => {
                      if (
                        !window.confirm(
                          "この種類のタスクを今後すべて自動処理にします。たまっている同種も自動実行されます。よろしいですか?(設定からあとで解除できます)",
                        )
                      )
                        return;
                      run(
                        () => api.action(item.id, "mute_category"),
                        "この種類を今後すべて自動で処理にしました",
                      );
                    }}
                  >
                    今後すべて自動で
                  </button>
                  <button
                    disabled={busy}
                    title="同じ種類のタスクを今後すべて要確認(エスカレ)に固定。たまっている同種も要確認に戻ります。このボタンからは戻せません(解除は設定から)"
                    onClick={() => {
                      if (
                        !window.confirm(
                          "この種類のタスクを今後すべて要確認に固定します。たまっている同種も要確認に戻ります。このボタンからは取り消せません(解除は設定からのみ)。よろしいですか?",
                        )
                      )
                        return;
                      run(
                        () => api.escalateCategory(item.id),
                        "この種類を今後すべて要確認にしました",
                      );
                    }}
                  >
                    今後すべて要確認に
                  </button>
                </span>
              )}
              <span className="spacer" />
              <button
                className="danger"
                disabled={busy}
                onClick={() => run(() => api.action(item.id, "reject"), "却下しました")}
              >
                却下
              </button>
            </>
          )}
          {busy && <span className="spinner">実行中…</span>}
        </div>
      )}

      {/* auto-done: 監査キューに見分けつかない形で混ぜる (§4-3)。autoDone は「やる(着手戻し)」が
          意味的に変なので、監査向けに『取り消す / 分類し直す』に限定する。reclassify→escalate は
          サーバが audit_bad に写像する(actions.ts)。 */}
      {autoDone && (
        <div className="actions" style={{ marginTop: 10 }}>
          {item.isAudit && <span className="chip-audit muted">確認(自動処理)</span>}
          {item.isAudit && (
            <button
              disabled={busy}
              title="この自動処理は妥当だった、と確認する(分類器への正のフィードバック)"
              onClick={() => run(() => api.audit(item.id, true), "妥当だったと確認しました")}
            >
              妥当だった（確認OK）
            </button>
          )}
          <button
            className="danger"
            disabled={busy}
            title="この自動実行を取り消す(痕跡は履歴に残る)"
            onClick={() => run(() => api.cancel(item.id), "実行を取り消しました")}
          >
            実行を取り消す
          </button>
          <Reclassify itemId={item.id} current={item.disposition} run={run} />
          <span className="muted" style={{ fontSize: 12 }}>
            痕跡は履歴に残ります。
          </span>
          {busy && <span className="spinner">実行中…</span>}
        </div>
      )}

      {/* 処分=ラベルの Undo: 直近1手の逆適用。カードを即消ししない前提で控えめに出す。
          ラベルは cancel(実行/成果物の取消)と紛れないよう『さばきを戻す』にする。
          カテゴリ締め(escalateCategory)は専用 action(escalate_category)で UNDOABLE から外して
          いるためここには出ない=締めは戻しにくい(背骨『締めは速く緩めは慎重』)。単件の
          reclassify→escalate(override)は通常どおり戻せる。
          着手中レーンでは『手放す(キューに戻す)』が同じ役割を果たすので、二重に出さない。 */}
      {item.undoableLabel && !inProgress && (
        <div style={{ marginTop: 6 }}>
          <button
            className="undo-inline"
            disabled={busy}
            title="直前のさばき(分類/着手など)を取り消して元に戻す"
            onClick={() => run(() => api.undoLabel(item.id), "直前のさばきを取り消しました")}
          >
            さばきを戻す（{undoLabelText(item.undoableLabel.action)}）
          </button>
        </div>
      )}
    </div>
  );
}

function undoLabelText(action: string): string {
  switch (action) {
    case "do":
      return "着手";
    case "reject":
      return "却下";
    case "reclassify":
    case "override":
      return "分類し直し";
    case "mute_category":
      return "この種類を自動化";
    default:
      return action;
  }
}

// general 成果物の出口 (§3.4): コピー / この方向で直す(一行指示→同じ execute 再走)。
function GeneralOutlet({
  item,
  run,
  busy,
  output,
}: {
  item: QueueItem;
  run: (fn: () => Promise<unknown>, doneMsg?: string) => Promise<void>;
  busy: boolean;
  output: string;
}) {
  const live = useLive();
  const [instruction, setInstruction] = useState("");
  return (
    <div className="actions" style={{ marginTop: 10, flexWrap: "wrap" }}>
      <button
        disabled={!output}
        onClick={() => {
          navigator.clipboard?.writeText(output);
          live("成果物をコピーしました");
        }}
      >
        コピー
      </button>
      <input
        type="text"
        placeholder="直す方向を一行で指示(例: もっと簡潔に / 表形式で)"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        style={{ flex: 1, minWidth: 180 }}
        aria-label="直す方向を一行で指示"
      />
      <button
        className="primary"
        disabled={busy || !instruction.trim()}
        title="左の一行指示を踏まえて、同じ実行をやり直す"
        onClick={() =>
          run(() => api.reExecute(item.id, instruction.trim()), "この指示でやり直しました").then(() =>
            setInstruction(""),
          )
        }
      >
        この指示でやり直す
      </button>
    </div>
  );
}

function Reclassify({
  itemId,
  current,
  run,
}: {
  itemId: string;
  current: Disposition | null;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  // 操作メニュー化: 常に見出し『分類し直す…』を表示し、選んだ段へ覆す(教師信号)。
  // 現在の分類は title に出す(value に束縛して「○○に変更」が現状と一致する誤読を避ける)。
  const cur = current ? DISPOSITION_LABEL[current] : "未分類";
  return (
    <select
      value=""
      aria-label="分類し直す"
      title={`分類し直す(現在: ${cur})。境界線への明示ナッジ=教師信号になります`}
      onChange={(e) => {
        const to = e.target.value;
        if (!to) return;
        run(() => api.action(itemId, "reclassify", to as Disposition));
      }}
    >
      <option value="" disabled>
        分類し直す…
      </option>
      <option value="auto">自動に変更</option>
      <option value="escalate">要確認に変更</option>
      <option value="human">要判断に変更</option>
    </select>
  );
}

// ---------------------------------------------------------------------------
function AddItem({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [domain, setDomain] = useState<"software" | "general">("general");
  const [projectDir, setProjectDir] = useState("");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [due, setDue] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const raw = body.trim();
    const typed = title.trim();
    if (!raw && !typed) return;
    // 「雑に貼る」: タイトル未記入なら本文から派生する。
    //  - 一行タスク(改行なし・短い)はそれ自体をタイトルにし本文は空(重複させない)。
    //  - 会話ログ/メモの貼り付けは先頭から暫定タイトルを作り、全文は本文に残す。
    //    暫定タイトルは分類時にAIの要約見出しで上書きされる(サーバ側)。
    let finalTitle = typed;
    let finalBody = raw;
    if (!finalTitle) {
      const oneLiner = !raw.includes("\n") && raw.length <= 80;
      if (oneLiner) {
        finalTitle = raw;
        finalBody = "";
      } else {
        finalTitle = provisionalTitle(raw);
      }
    }
    setBusy(true);
    try {
      await api.createItem({
        title: finalTitle,
        body: finalBody,
        domain,
        projectDir: domain === "software" && projectDir.trim() ? projectDir.trim() : null,
        projectId: projectId || null,
        priority,
        dueDate: parseDate(due),
      });
      setTitle("");
      setBody("");
      setProjectDir("");
      setDue("");
      setPriority("normal");
      setOpen(false);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="add-form">
        {/* 本文(会話ログ/メモ)を主役に。雑に貼るだけで登録できる(新規儀式ゼロ §3.1)。 */}
        <textarea
          placeholder="会話・メモ・タスクを雑に貼る（タイトルは空でOK。Ctrl/⌘+Enterで登録）"
          value={body}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()}
        />
        <div className="row">
          <span className="muted" style={{ flex: 1, fontSize: "0.85em" }}>
            大きい塊は1件のまま「要確認」で残ります。割るかどうかはあなたが決めます。
          </span>
          <button className="primary" disabled={busy} onClick={submit}>
            登録して分類
          </button>
          <button onClick={() => setOpen((o) => !o)}>{open ? "詳細を閉じる" : "詳細"}</button>
        </div>
        {open && (
          <>
            <input
              type="text"
              placeholder="タイトル（空なら本文先頭から自動。AIが要約で差し替え）"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="row">
              <label className="muted">
                案件:{" "}
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">なし</option>
                  {state.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="muted">
                優先度:{" "}
                <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  <option value="urgent">緊急</option>
                  <option value="high">高</option>
                  <option value="normal">中</option>
                  <option value="low">低</option>
                </select>
              </label>
              <label className="muted">
                期日: <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
              </label>
            </div>
            <div className="row">
              <label className="muted">
                領域:{" "}
                <select value={domain} onChange={(e) => setDomain(e.target.value as "software" | "general")}>
                  <option value="general">一般</option>
                  <option value="software">ソフト開発</option>
                </select>
              </label>
              {domain === "software" && (
                <input
                  type="text"
                  placeholder="作業ディレクトリ (例: /home/you/project)"
                  value={projectDir}
                  onChange={(e) => setProjectDir(e.target.value)}
                  style={{ flex: 1 }}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function DecomposeModal({
  item,
  onClose,
  onChange,
}: {
  item: Item;
  onClose: () => void;
  onChange: () => void;
}) {
  const [options, setOptions] = useState<DecomposeOption[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // StrictMode の二重起動でも item.id ごとに分解リクエストを1回だけ発火させる ref ガード。
  const requestedFor = useRef<string | null>(null);
  // a11y: 初期 focus(閉じるボタン)と、閉じたら発火元へ focus 復帰。
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = `decompose-title-${item.id}`;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    return () => {
      opener?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (requestedFor.current === item.id) return;
    requestedFor.current = item.id;
    let cancelled = false;
    api
      .decompose(item.id)
      .then((r) => {
        if (!cancelled) setOptions(r.options);
      })
      .catch((e) => {
        if (!cancelled) setErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  const apply = async (opt: DecomposeOption) => {
    setApplying(true);
    try {
      await api.applyDecompose(item.id, opt);
      await onChange();
      onClose();
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="row" style={{ marginBottom: 12 }}>
          <h3 id={titleId} style={{ margin: 0, flex: 1 }}>
            分解: {item.title}
          </h3>
          <button ref={closeBtnRef} onClick={onClose}>
            閉じる
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12.5 }}>
          割り方の選択肢。サイクル長は不確実性に反比例（不明な段はPoCで情報を買う短サイクル §2.3）。
        </p>
        {err && <div className="cold-banner">分解に失敗: {err}</div>}
        {!options && !err && <p className="spinner">AIが割り方を考えています…</p>}
        {options?.length === 0 && <p className="muted">提案が得られませんでした。</p>}
        {options?.map((opt, i) => (
          <div className="option-card" key={i}>
            <div className="row">
              <strong style={{ flex: 1 }}>{opt.label}</strong>
              <span className="badge">{opt.process === "iterative" ? "反復" : "一括"}</span>
              <button className="primary" disabled={applying} onClick={() => apply(opt)}>
                この割り方で作る
              </button>
            </div>
            <div className="reason">{opt.rationale}</div>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {opt.children.map((c, j) => (
                <li key={j} style={{ fontSize: 12.5, marginBottom: 6 }}>
                  <span className="muted">
                    {c.kind === "leaf" ? "▸" : "◆"} {c.title}{" "}
                    <span className="badge kind">{RUNG_LABEL[c.rung]}</span>
                    {c.projectDir && (
                      <span className="badge" title={c.projectDir}>
                        📁 {c.projectDir.split("/").pop() || c.projectDir}
                      </span>
                    )}
                  </span>
                  {c.spec && (
                    <details style={{ marginLeft: 14, marginTop: 2 }}>
                      <summary className="muted" style={{ fontSize: 11.5, cursor: "pointer" }}>
                        詳細 / spec を見る
                      </summary>
                      <div
                        className="muted"
                        style={{ fontSize: 11.5, opacity: 0.85, whiteSpace: "pre-wrap", marginTop: 4 }}
                      >
                        {c.spec}
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function TreeView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [projFilter, setProjFilter] = useState("");
  const scope = projFilter
    ? state.items.filter((i) => i.projectId === projFilter)
    : state.items;
  const scopeIds = new Set(scope.map((i) => i.id));
  // フィルタ時は、その案件のアイテムのうち親がスコープ外なものをルート扱いにする。
  const roots = scope.filter((i) => !i.parentId || !scopeIds.has(i.parentId));
  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>バックログ（粒度つき）</h3>
        <label className="muted">
          案件:{" "}
          <select value={projFilter} onChange={(e) => setProjFilter(e.target.value)}>
            <option value="">すべて</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {roots.length === 0 ? (
        <p className="muted">アイテムがありません。</p>
      ) : (
        roots.map((r) => <TreeNode key={r.id} item={r} all={state.items} onChange={onChange} />)
      )}
    </div>
  );
}

function TreeNode({ item, all, onChange }: { item: Item; all: Item[]; onChange: () => void }) {
  const children = all.filter((i) => i.parentId === item.id);
  return (
    <div>
      <div className="tree-row">
        <span>{item.kind === "leaf" ? "▸" : "◆"}</span>
        <span style={{ flex: 1 }}>
          {item.title}{" "}
          <span className="muted" style={{ fontSize: 11 }}>
            [{RUNG_LABEL[item.rung]}]
          </span>
        </span>
        <PriorityBadge priority={item.priority} />
        <DueBadge due={item.dueDate} />
        {item.disposition && (
          <span className={`badge disp-${item.disposition}`}>
            {DISPOSITION_LABEL[item.disposition]}
          </span>
        )}
        <span className="badge">{STATUS_LABEL[item.status] ?? item.status}</span>
        {item.kind === "node" && !item.parentId && !item.projectId && (
          <button
            title="この問いを案件に格上げ"
            onClick={async () => {
              await api.toProject(item.id);
              await onChange();
            }}
          >
            案件に昇格
          </button>
        )}
        <button
          className="danger"
          onClick={async () => {
            await api.deleteItem(item.id);
            await onChange();
          }}
        >
          削除
        </button>
      </div>
      {children.length > 0 && (
        <div className="tree-node">
          {children.map((c) => (
            <TreeNode key={c.id} item={c} all={all} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function SessionsView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [sel, setSel] = useState<string | null>(state.sessions[0]?.name ?? null);
  const [initing, setIniting] = useState(false);

  const init = async () => {
    setIniting(true);
    try {
      await api.initAi();
      await onChange();
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

// ---------------------------------------------------------------------------
// 再調律の取っ手 (§4 末): 最適点に着地する画面ではなく、動く標的を追う計器盤。
function SettingsView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const s = state.settings;
  const set = async (patch: Partial<typeof s>) => {
    await api.updateSettings(patch);
    await onChange();
  };

  return (
    <>
      <div className="panel">
        <h3>プロダクトの前提（分解・実行の文脈）</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          分類/分解(control)が判断するのに要る<b>要約と運用方針</b>を書く場所。ここに書いた前提が
          分類/分解/実行すべてのプロンプトに注入される（上段の鋭い投資は下段で複利 §2.2）。
          アーキ・規約・契約の<b>詳細はコードと一緒に各repoのdocs(CLAUDE.md/README/docs)に置き</b>、
          実行時はworkerがそれを正典として読む。ここに詳細を転記するとrepoとドリフトするので避ける。
        </p>
        <textarea
          rows={5}
          style={{ width: "100%" }}
          placeholder={
            "ソフト開発の例: BtoB SaaSの請求管理。TS/Node/Postgres。決済はStripe。本番操作は必ず人間承認。詳細は各repoのdocs参照。\n" +
            "一般業務の例: 採用広報の運用。社外公開物は必ず人間確認。トーンは丁寧・簡潔。関係者: 法務/PR。"
          }
          defaultValue={s.productContext}
          onBlur={(e) => set({ productContext: e.target.value })}
        />
      </div>

      <div className="panel">
        <h3>再調律スライダー</h3>
        <label className="field">
          <span>
            締め具合 (escalation tightness): {Math.round(s.escalationTightness * 100)}% — 高いほど
            エスカレ寄り。締めるのは速く・緩めるのは慎重に (§3.6-3)
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={s.escalationTightness}
            onChange={(e) => set({ escalationTightness: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>
            監査サンプル率 (audit rate): {Math.round(s.auditRate * 100)}% — 自動処理のこの割合を
            「30秒確認」としてキューに混ぜる。節約したい注意を意図的に少額払う (§3.6-2)
          </span>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={s.auditRate}
            onChange={(e) => set({ auditRate: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>
            外部送信(push/PR作成)を承認時に解禁: {s.allowExternalSend ? "ON" : "OFF"} — ON にすると
            ワンタップ承認した実装タスクで worker が push / PR 作成まで実行できる(マージ・本番デプロイ・
            削除はしない=人間)。緩め方向なので既定 OFF・明示オプトイン (§3.4/§3.6-3)
          </span>
          <input
            type="checkbox"
            checked={s.allowExternalSend}
            onChange={(e) => set({ allowExternalSend: e.target.checked })}
          />
        </label>
      </div>

      <div className="panel">
        <h3>学習した境界（明示ルール）</h3>
        {state.rules.filter((r) => r.active).length === 0 ? (
          <p className="muted">まだルールはありません。さばきが溜まると基準率補正が境界を倒します。</p>
        ) : (
          state.rules
            .filter((r) => r.active)
            .map((r) => (
              <div className="tree-row" key={r.id}>
                <span style={{ flex: 1 }}>
                  <b>{r.category}</b> → {DISPOSITION_LABEL[r.forcedDisposition]}{" "}
                  <span className="muted" style={{ fontSize: 11 }}>
                    ({r.source === "learned" ? "学習" : "手動"}) {r.note}
                  </span>
                </span>
                <button onClick={() => api.deactivateRule(r.id).then(onChange)}>解除</button>
              </div>
            ))
        )}
      </div>

      <div className="panel">
        <h3>AI連携</h3>
        <label className="field">
          <span>worker 並列数 (クォータ天井 §6): {s.maxWorkers}</span>
          <input
            type="range"
            min={0}
            max={6}
            step={1}
            value={s.maxWorkers}
            onChange={(e) => set({ maxWorkers: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>control 起動コマンド（許可で止まる時は --dangerously-skip-permissions 等に）</span>
          <input
            type="text"
            value={s.claudeControlCmd}
            onChange={(e) => set({ claudeControlCmd: e.target.value })}
          />
        </label>
        <label className="field">
          <span>worker 起動コマンド</span>
          <input
            type="text"
            value={s.claudeWorkerCmd}
            onChange={(e) => set({ claudeWorkerCmd: e.target.value })}
          />
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={s.useHeadless}
            onChange={(e) => set({ useHeadless: e.target.checked })}
          />
          <span className="muted">
            headless(claude -p)で動かす — tmux不要・検証は速いが将来課金リスク (§6)
          </span>
        </label>
      </div>

      {/* MCP 接続スニペット (コピー可) + 直近の捕獲。サーバ未提供時(undefined)は出さない。 */}
      {(state.mcpEndpoint || state.captureStats) && (
        <div className="panel">
          <h3>MCP 接続 / 取り込み</h3>
          {state.mcpEndpoint && <McpSnippet endpoint={state.mcpEndpoint} />}
          {state.captureStats && (
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              直近の捕獲: {state.captureStats.count} 件
              {state.captureStats.lastAt != null
                ? ` / 最終 ${new Date(state.captureStats.lastAt).toLocaleString("ja-JP")}`
                : ""}
            </p>
          )}
        </div>
      )}
    </>
  );
}

function McpSnippet({ endpoint }: { endpoint: string }) {
  const live = useLive();
  const snippet = `claude mcp add --transport http winnow ${endpoint}`;
  return (
    <>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Claude などの MCP クライアントから、作業中に直接アイテムを捕獲する口。次のコマンドで接続できます。
      </p>
      <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <pre
          className="exec-output"
          style={{ flex: 1, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}
        >
          {snippet}
        </pre>
        <button
          aria-label="MCP 接続コマンドをコピー"
          onClick={() => {
            navigator.clipboard?.writeText(snippet);
            live("MCP 接続コマンドをコピーしました");
          }}
        >
          コピー
        </button>
      </div>
    </>
  );
}
