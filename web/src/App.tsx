import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DecomposeOption } from "./api.js";
import { MiniScores, ScoreBadges } from "./components/ScoreBadges.js";
import { TerminalPane } from "./components/TerminalPane.js";
import type { AppState, Disposition, Item, QueueItem } from "./types.js";
import { RUNG_LABEL } from "./types.js";

type Tab = "queue" | "tree" | "sessions" | "settings";

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
            ["tree", "木"],
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

      {tab === "queue" && <QueueView state={state} onChange={refresh} />}
      {tab === "tree" && <TreeView state={state} onChange={refresh} />}
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
      <AddItem onChange={onChange} />

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
          <QueueCard key={q.id} item={q} onChange={onChange} onDecompose={() => setDecomposeFor(q)} />
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
  onChange,
  onDecompose,
}: {
  item: QueueItem;
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
            <button disabled={busy} onClick={() => run(() => api.action(item.id, "demote"))}>
              下段へ降ろす
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
      <option value="escalate">→上げる</option>
      <option value="human">→人間</option>
    </select>
  );
}

// ---------------------------------------------------------------------------
function AddItem({ onChange }: { onChange: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [domain, setDomain] = useState<"software" | "general">("general");
  const [projectDir, setProjectDir] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.createItem({
        title: title.trim(),
        body: body.trim(),
        domain,
        projectDir: domain === "software" && projectDir.trim() ? projectDir.trim() : null,
      });
      setTitle("");
      setBody("");
      setProjectDir("");
      setOpen(false);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="add-form">
        <div className="row">
          <input
            type="text"
            placeholder="アイテムを登録（普段のさばきがそのまま教師信号になる）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && submit()}
          />
          <button className="primary" disabled={busy} onClick={submit}>
            登録して分類
          </button>
          <button onClick={() => setOpen((o) => !o)}>{open ? "詳細を閉じる" : "詳細"}</button>
        </div>
        {open && (
          <>
            <textarea
              placeholder="詳細・スペック（上段への鋭い投資は下段で複利で効く §2.2）"
              value={body}
              rows={3}
              onChange={(e) => setBody(e.target.value)}
            />
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
                <li key={j} className="muted" style={{ fontSize: 12.5 }}>
                  {c.kind === "leaf" ? "▸" : "◆"} {c.title}{" "}
                  <span className="badge kind">{RUNG_LABEL[c.rung]}</span>
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
  const roots = state.items.filter((i) => !i.parentId);
  return (
    <div className="panel">
      <h3>木（ラダー高度つき）</h3>
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
        {item.disposition && (
          <span className={`badge disp-${item.disposition}`}>{item.disposition}</span>
        )}
        <span className="badge">{item.status}</span>
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
                  <b>{r.category}</b> → {r.forcedDisposition}{" "}
                  <span className="muted" style={{ fontSize: 11 }}>
                    ({r.source}) {r.note}
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
