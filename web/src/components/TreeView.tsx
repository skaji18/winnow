import { useRef, useState } from "react";
import { api } from "../api.js";
import { useLive } from "../live.js";
import { DueBadge, PriorityBadge } from "./Bits.js";
import { useConfirm } from "./ConfirmDialog.js";
import { Select } from "./Select.js";
import type { AppState, Item } from "../types.js";
import { DISPOSITION_LABEL, RUNG_LABEL, STATUS_LABEL } from "../types.js";

// ---------------------------------------------------------------------------
export function TreeView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [projFilter, setProjFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // アーカイブ案件配下は既定で畳む (read 時導出・アイテム非変異。復元で自動復帰)。
  // 案件フィルタで archived 案件を明示選択したときは参照表示する (参照可能性は落とさない)。
  const archivedIds = new Set(
    state.projects.filter((p) => p.status === "archived").map((p) => p.id),
  );
  // pool を素通しにするのは「トグルON」か「archived 案件の明示選択」だけ。active 案件の
  // フィルタ中はアーカイブ除外を維持する (ツリー跨ぎの子がぶら下がる穴を開けない)。
  const pool =
    showArchived || (projFilter && archivedIds.has(projFilter))
      ? state.items
      : state.items.filter((i) => !(i.projectId && archivedIds.has(i.projectId)));
  const scope = projFilter ? pool.filter((i) => i.projectId === projFilter) : pool;
  const scopeIds = new Set(scope.map((i) => i.id));
  // フィルタ時は、その案件のアイテムのうち親がスコープ外なものをルート扱いにする。
  const roots = scope.filter((i) => !i.parentId || !scopeIds.has(i.parentId));
  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>バックログ（粒度つき）</h3>
        <label className="muted" style={{ fontSize: 11.5 }}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />{" "}
          アーカイブ案件も表示
        </label>
        <label className="muted">
          案件:{" "}
          <Select
            value={projFilter}
            onChange={setProjFilter}
            ariaLabel="案件で絞り込む"
            options={[
              { value: "", label: "すべて" },
              ...state.projects.map((p) => ({
                value: p.id,
                label: p.name + (p.status === "archived" ? "（アーカイブ）" : ""),
              })),
            ]}
          />
        </label>
      </div>
      {roots.length === 0 ? (
        <p className="muted">アイテムがありません。</p>
      ) : (
        roots.map((r) => <TreeNode key={r.id} item={r} all={pool} onChange={onChange} />)
      )}
    </div>
  );
}

function TreeNode({ item, all, onChange }: { item: Item; all: Item[]; onChange: () => void }) {
  const children = all.filter((i) => i.parentId === item.id);
  const live = useLive();
  const confirmDialog = useConfirm();
  return (
    <div>
      <div className="tree-row">
        <span>{item.kind === "leaf" ? "▸" : "◆"}</span>
        <span className="tree-title">
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
            // 折り返しの多い狭幅レイアウトでの誤タップが即削除にならないよう確認を挟む
            // (削除は UNDOABLE 外の不可逆操作)。
            const ok = await confirmDialog({
              title: "アイテムを削除",
              body: `「${item.title}」を削除します。子アイテムも一緒に消えます。削除は取り消せません。`,
              okLabel: "削除する",
              danger: true,
            });
            if (!ok) return;
            try {
              await api.deleteItem(item.id);
              await onChange();
            } catch (e) {
              // 失敗を黙って捨てない: 無反応に見える「死んだボタン」を作らない。
              live(`削除に失敗しました: ${(e as Error).message}`);
            }
          }}
        >
          削除
        </button>
      </div>
      {/* 事後編集の2枠 (DECISIONS「人間実施の結果の下流受け渡し」): done 項目はキューから消える
          ため、全項目が出るこの俯瞰面が resolution/context 編集の家。閉じた details 2つの薄い
          一行に収め、ツリーの密度を壊さない。 */}
      <div style={{ display: "flex", gap: 12, margin: "0 0 2px 22px" }}>
        <InlineItemText
          item={item}
          field="context"
          label="前提(メモ)"
          placeholder="着手前の前提 (AI に効く: この項目と配下の分類/分解/実行に注入される)"
          onChange={onChange}
        />
        <InlineItemText
          item={item}
          field="resolution"
          label="実施の結果"
          placeholder="完了時の結果・決定 (完了済みなら下流の兄弟タスクの AI 実行に前提として渡る)"
          onChange={onChange}
        />
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

// context(着手前の前提)/resolution(完了後の実施結果)のインライン編集。案件前提
// (Projects.tsx) と同じ details+非制御 textarea+onBlur 型だが、items には楽観ロックが
// あるので expectedUpdatedAt を必ず送る (blur 全文上書きが他所の更新を黙って巻き戻す穴を
// 409 で塞ぐ)。409/失敗時: 非制御 textarea は TreeNode が item.id で key され remount
// されないため、onChange 再取得後も DOM の入力値が残る=入力保持。通知は既存様式の
// aria-live (ネイティブダイアログ禁止)。
//
// 楽観ロックの基準版は「表示中の本文が基づく版」= mount 時の {value, updatedAt} スナップショット
// (base ref)。最新レンダの item.updatedAt を送ると、3秒ポーリングがロックトークンだけを最新化し、
// 陳腐化した defaultValue との組で他所の編集を 409 なしで黙って巻き戻す (無編集 blur でも
// v !== 最新 saved で発火する)。無変更ガードの比較対象も base.value — 最新 saved と比べると
// 他所更新後の無入力 blur が逆発火する。item.updatedAt で key して remount する代替は採らない:
// 無関係フィールドの更新 (update は常に updatedAt を洗う) でも書きかけ入力が消え、
// INVARIANTS の「409/失敗時に入力を保持」を破る。
function InlineItemText({
  item,
  field,
  label,
  placeholder,
  onChange,
}: {
  item: Item;
  field: "context" | "resolution";
  label: string;
  placeholder: string;
  onChange: () => void;
}) {
  const live = useLive();
  const saved = item[field] ?? "";
  // mount 時スナップショット (defaultValue と同一レンダ由来)。保存成功時はサーバ応答で更新。
  const base = useRef<{ value: string; updatedAt: number }>({
    value: saved,
    updatedAt: item.updatedAt,
  });
  // 409 後は「ユーザが通知を見て明示的に再編集する」まで再送しない (自動で基準版を洗うと
  // 保護が一発しか効かず、再 blur が他所の編集を黙って上書きする状態に戻る)。
  const conflicted = useRef(false);
  return (
    <details style={{ flex: 1, minWidth: 0 }}>
      <summary className="muted" style={{ fontSize: 11.5, cursor: "pointer" }}>
        {label}
        {saved.trim() ? "（記入あり）" : ""}
      </summary>
      <textarea
        rows={3}
        style={{ width: "100%", marginTop: 4 }}
        placeholder={placeholder}
        defaultValue={saved}
        aria-label={`${label}: ${item.title}`}
        onInput={() => {
          conflicted.current = false;
        }}
        onBlur={async (e) => {
          const v = e.target.value;
          // 変更なしの blur は送らない: 無用な PATCH は updatedAt を洗い、滞留表示 (ageDays/
          // staleDays) を偽リセットする。比較は基準版 (表示本文の由来) と。
          if (v === base.current.value) return;
          if (conflicted.current) return; // 409 後・再編集前は再送しない
          try {
            const updated = await api.updateItem(
              item.id,
              field === "context" ? { context: v } : { resolution: v },
              base.current.updatedAt,
            );
            base.current = { value: v, updatedAt: updated.updatedAt };
            await onChange();
          } catch (err) {
            const msg = (err as Error).message;
            if (msg.startsWith("CONFLICT")) {
              // 409 応答の current で基準版を最新化する (再編集後の保存を可能にする)。
              // 解析できなければ基準版は据え置き = 次の blur も 409 (安全側)。
              try {
                const cur = JSON.parse(msg.slice("CONFLICT ".length)).current as Item;
                base.current = { value: cur[field] ?? "", updatedAt: cur.updatedAt };
              } catch {
                /* 据え置き */
              }
              conflicted.current = true;
              live(
                "他所で更新されました。最新に更新します。入力は欄に残っています。上書き保存するには欄を編集し直してください。",
              );
              await onChange();
            } else {
              live(`保存に失敗しました: ${msg}`);
            }
          }
        }}
      />
    </details>
  );
}
