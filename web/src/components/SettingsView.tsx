import { api } from "../api.js";
import { copyText } from "./Bits.js";
import { useLive } from "../live.js";
import type { AppState } from "../types.js";
import { DISPOSITION_LABEL } from "../types.js";

// ---------------------------------------------------------------------------
// 再調律の取っ手 (§4 末): 最適点に着地する画面ではなく、動く標的を追う計器盤。
export function SettingsView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const live = useLive();
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

      <div className="panel">
        <h3>タイムアウト（実行が長い時に伸ばす）</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          「明らかに時間がかかる実行」を持つ環境で、AI op の締切を伸ばせる。実行(worker)が上限を超えると
          <b>timed_out</b> に倒れ、worker が後から完了すれば<b>自動で取り込む</b>(待たず再実行も可 §4-4)。
          ワーカー獲得(acquire)待ちは work timeout とは別軸（プール混雑＝再試行で解ける一時失敗）。
        </p>
        {/* minMs はサーバ側 zod の下限と一致させる (不一致だと一見有効な値が黙って 400 になる)。 */}
        <SecField label="実行 worker" valueMs={s.executeTimeoutMs} minMs={30_000} onSet={(ms) => set({ executeTimeoutMs: ms })} />
        <SecField label="分解 control" valueMs={s.decomposeTimeoutMs} minMs={15_000} onSet={(ms) => set({ decomposeTimeoutMs: ms })} />
        <SecField label="分類 control" valueMs={s.classifyTimeoutMs} minMs={15_000} onSet={(ms) => set({ classifyTimeoutMs: ms })} />
        <SecField label="ワーカー獲得待ち acquire" valueMs={s.acquireTimeoutMs} minMs={5_000} onSet={(ms) => set({ acquireTimeoutMs: ms })} />
        <SecField
          label="timed_out 猶予（超えたら failed）"
          valueMs={s.timedOutGraceMs}
          minMs={60_000}
          onSet={(ms) => set({ timedOutGraceMs: ms })}
        />
      </div>

      {/* バージョンと更新チェック。バナー(App 直下)は新版がある時だけ出るので、
          ここは「いま何が動いているか」と手動チェックの置き場 (サーバ未提供時は出さない)。 */}
      {state.version && (
        <div className="panel">
          <h3>バージョン・更新</h3>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            現在 v{state.version}
            {state.update?.latestTag ? ` / 最新リリース ${state.update.latestTag}` : ""}
            {state.update?.checkedAt != null
              ? ` (確認 ${new Date(state.update.checkedAt).toLocaleString("ja-JP")})`
              : " (未チェック)"}
          </p>
          {state.update?.error && (
            <p className="muted" style={{ fontSize: 12 }}>
              更新チェックに失敗: {state.update.error}
            </p>
          )}
          <button
            onClick={() =>
              api
                .checkUpdate()
                .then((u) => {
                  // サーバはチェック失敗を throw せず error に畳んで返す。失敗を「最新です」と
                  // 誤案内しない (エラーを黙って捨てない)。
                  if (u.error) live(`更新チェックに失敗: ${u.error}`);
                  else if (u.available) live(`新しいバージョン ${u.latestTag} があります`);
                  else live("最新です");
                  onChange();
                })
                .catch((e) => live(`更新チェックに失敗: ${(e as Error).message}`))
            }
          >
            更新を確認
          </button>
        </div>
      )}

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

// タイムアウト設定の 1 行 (ms ↔ 秒の変換を吸収)。onBlur で確定し、キー毎の PATCH を避ける。
// サーバ側 zod がフィールド毎の下限(execute=30s/decompose・classify=15s 等)を最終ゲートするので、
// minMs をその下限に合わせて min 属性で誘導しつつ、下回る入力は PATCH せず弾く(黙って 400 を防ぐ)。
function SecField({
  label,
  valueMs,
  minMs,
  onSet,
}: {
  label: string;
  valueMs: number;
  minMs: number;
  onSet: (ms: number) => void | Promise<void>;
}) {
  const minSec = Math.ceil(minMs / 1000);
  return (
    <label className="field">
      <span>
        {label}: {Math.round(valueMs / 1000)} 秒
      </span>
      <input
        type="number"
        min={minSec}
        step={5}
        defaultValue={Math.round(valueMs / 1000)}
        onBlur={(e) => {
          const sec = Number(e.target.value);
          if (Number.isFinite(sec) && sec * 1000 >= minMs) void onSet(Math.round(sec * 1000));
        }}
      />
    </label>
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
          onClick={async () => {
            live(
              (await copyText(snippet))
                ? "MCP 接続コマンドをコピーしました"
                : "コピーできませんでした。左のコマンドを長押しで選択してください",
            );
          }}
        >
          コピー
        </button>
      </div>
    </>
  );
}
