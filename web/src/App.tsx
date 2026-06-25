import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DecomposeOption } from "./api.js";
import { DueBadge, PriorityBadge, ProjectChip, parseDate, provisionalTitle } from "./components/Bits.js";
import { ProjectsView } from "./components/Projects.js";
import { MiniScores, ScoreBadges } from "./components/ScoreBadges.js";
import { SprintsView } from "./components/Sprints.js";
import { TerminalPane } from "./components/TerminalPane.js";
import type { AppState, Disposition, Item, Priority, QueueItem } from "./types.js";
import { DISPOSITION_LABEL, RUNG_LABEL, STATUS_LABEL } from "./types.js";

type Tab = "queue" | "sprints" | "projects" | "backlog" | "sessions" | "settings";

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>("queue");
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="app">
      <header className="top">
        <h1>Winnow</h1>
        <span className="tagline">判断アテンションを配給する道具</span>
        <span className="summary-line" title="ループを閉じて見せる (§4-5)">
          {state.summary.line}
        </span>
      </header>

      <nav className="tabs">
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
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </nav>

      {error && <div className="cold-banner">通信エラー: {error}</div>}

      {/* どこからでも即キャプチャ (新規儀式ゼロ §4)。全タブ共通の登録口。 */}
      <AddItem state={state} onChange={refresh} />

      {tab === "queue" && <QueueView state={state} onChange={refresh} />}
      {tab === "sprints" && <SprintsView state={state} onChange={refresh} />}
      {tab === "projects" && <ProjectsView state={state} onChange={refresh} />}
      {tab === "backlog" && <TreeView state={state} onChange={refresh} />}
      {tab === "sessions" && <SessionsView state={state} onChange={refresh} />}
      {tab === "settings" && <SettingsView state={state} onChange={refresh} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// キュー: 火の海ではなくエスカレーションだけの短いキュー (§4)
// ---------------------------------------------------------------------------
function QueueView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [decomposeFor, setDecomposeFor] = useState<Item | null>(null);

  return (
    <>
      {/* コールドスタート=Jカーブの期待値管理 (§4 末, §5) */}
      {state.autoFolded > 0 && (
        <div className="cold-banner">
          自動で畳んだ {state.autoFolded} 件はここに出していません。序盤はキューが短くなりにくいですが、
          それは境界線を学んでいる音です。
        </div>
      )}

      {state.queue.length === 0 ? (
        <div className="empty">キューは空です。新しいアイテムを登録すると分類されます。</div>
      ) : (
        state.queue.map((q) => (
          <QueueCard
            key={q.id}
            item={q}
            state={state}
            onChange={onChange}
            onDecompose={() => setDecomposeFor(q)}
          />
        ))
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
  onChange,
  onDecompose,
}: {
  item: QueueItem;
  state: AppState;
  onChange: () => void;
  onDecompose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const proposed = item.executionStatus === "proposed";
  // 監査サンプルは通常アイテムと見分けがつかない (§4-3): カード枠に特別扱いを残さない。
  const autoDone = item.autoExecuted && item.executionStatus === "succeeded";
  const cls = `card${proposed ? " proposed" : ""}`;

  return (
    <div className={cls}>
      <div className="card-head">
        <span className="card-title">{item.title}</span>
        <ScoreBadges item={item} />
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
      {item.reason && <div className="reason">{item.reason}</div>}
      <MiniScores item={item} />

      {item.executionResult && (
        <details className="exec">
          <summary className="muted">実行結果 / メモを見る</summary>
          <pre>{item.executionResult}</pre>
        </details>
      )}

      {autoDone && (
        // 自動実行済みの安く取り消せる経路 (§4-4). 結果サマリは上の executionResult details が出している。
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="danger" disabled={busy} onClick={() => run(() => api.cancel(item.id))}>
            取り消す
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            痕跡は履歴に残るが、副作用は自動では巻き戻されません。
          </span>
          {busy && <span className="spinner">実行中…</span>}
        </div>
      )}

      {!autoDone && (
      <div className="actions" style={{ marginTop: 10 }}>
        {proposed ? (
          // 不可逆/高ステークス: ワンタップ承認 (§3.4, §4-4)
          <>
            <span className="badge disp-escalate">承認待ち</span>
            <button className="primary" disabled={busy} onClick={() => run(() => api.approve(item.id))}>
              承認して実行
            </button>
            <button className="danger" disabled={busy} onClick={() => run(() => api.cancel(item.id))}>
              取り消す
            </button>
          </>
        ) : (
          // 通常の処分=ラベル (§4-1). 監査サンプルもここに同じ形で混ざる (§4-3):
          // 教師信号はこれら通常アクションからサーバ側で導出する (src/server/actions.ts)。
          <>
            {/* DECISIONS.md L45: 枠なし・控えめなチップ1つだけ許容。アクション集合は通常と同一。 */}
            {item.isAudit && <span className="chip-audit muted">確認(自動処理)</span>}
            <button disabled={busy} onClick={() => run(() => api.action(item.id, "do"))}>
              やる
            </button>
            {item.kind === "node" ? (
              <button disabled={busy} onClick={onDecompose}>
                分解する
              </button>
            ) : (
              <button disabled={busy} onClick={() => run(() => api.execute(item.id))}>
                実行する
              </button>
            )}
            {item.kind === "node" && !item.projectId && (
              <button
                disabled={busy}
                title="この問いを案件(入れ物)に格上げし、サブツリーごと紐付ける"
                onClick={() => run(() => api.toProject(item.id))}
              >
                案件に昇格
              </button>
            )}
            <button disabled={busy} onClick={() => run(() => api.action(item.id, "demote"))}>
              粒度を下げる
            </button>
            <Reclassify itemId={item.id} current={item.disposition} run={run} />
            <button
              disabled={busy}
              title="この種類はもう上げるな(自動に倒す)"
              onClick={() => run(() => api.action(item.id, "mute_category"))}
            >
              もう上げるな
            </button>
            <span className="spacer" />
            <button className="danger" disabled={busy} onClick={() => run(() => api.action(item.id, "reject"))}>
              却下
            </button>
          </>
        )}
        {busy && <span className="spinner">実行中…</span>}
      </div>
      )}
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
  return (
    <select
      value={current ?? "escalate"}
      title="分類し直す(境界線への明示ナッジ=教師信号)"
      onChange={(e) => run(() => api.action(itemId, "reclassify", e.target.value as Disposition))}
    >
      <option value="auto">→自動</option>
      <option value="escalate">→要確認</option>
      <option value="human">→要判断</option>
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0, flex: 1 }}>分解: {item.title}</h3>
          <button onClick={onClose}>閉じる</button>
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
                    <div
                      className="muted"
                      style={{ fontSize: 11.5, marginLeft: 14, opacity: 0.85, whiteSpace: "pre-wrap" }}
                    >
                      {c.spec}
                    </div>
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
          何を作っているか・スタック・規約・方針。ここに書いた前提が分類/分解/実行すべての
          プロンプトに注入され、リーフまで文脈が降りる（上段の鋭い投資は下段で複利 §2.2）。
        </p>
        <textarea
          rows={5}
          style={{ width: "100%" }}
          placeholder="例: BtoB SaaSの請求管理。TS/Node/Postgres。決済はStripe。本番操作は必ず人間承認。命名は…"
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
    </>
  );
}
