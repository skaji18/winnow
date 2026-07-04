import type { DueBucket, HorizonCell, Item } from "../types.js";
import { RUNG_LABEL } from "../types.js";

// horizon レンズ: rung × due の中長期見通し(読み取り専用)。上段はぼかし、下段 leaf のみ鋭い due。
// 完了線/残数/消化率は出さない。state.horizon 未提供時は非表示(現状維持)。
const DUE_BUCKET_LABEL: Record<DueBucket, string> = {
  over: "期限超過",
  soon: "間近",
  week: "今週",
  later: "それ以降",
  unknown: "期日なし",
};
export function HorizonLens({ cells }: { cells?: HorizonCell[] }) {
  if (!cells || cells.length === 0) {
    return <div className="empty">見通しに出せる項目がありません（期日や上位の意図を足すと現れます）。</div>;
  }
  // rung ごとに行をまとめ、その中で due バケット順に並べる(cells は既にサーバ側で決定論ソート済み)。
  const byRung = new Map<string, HorizonCell[]>();
  for (const c of cells) (byRung.get(c.rung) ?? byRung.set(c.rung, []).get(c.rung)!).push(c);
  return (
    <div className="horizon">
      <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
        中長期の見通し。上段は時間帯のみ（確定日付にしない）、実行タスクだけ鋭い期日を出します。
      </p>
      {[...byRung.entries()].map(([rung, rungCells]) => (
        <div className="horizon-row" key={rung}>
          <div className="horizon-rung">{RUNG_LABEL[rung as Item["rung"]] ?? rung}</div>
          <div className="horizon-cells">
            {rungCells.map((c) => (
              <div className="horizon-cell" key={c.dueBucket}>
                <div className="horizon-bucket muted">{DUE_BUCKET_LABEL[c.dueBucket]}</div>
                {c.entries.map((e) => (
                  <div className="horizon-entry" key={e.id}>
                    <span className="horizon-title">{e.title}</span>
                    {e.sharp && e.dueDate != null && (
                      <span className="horizon-due muted">
                        {new Date(e.dueDate).toLocaleDateString("ja-JP", {
                          month: "numeric",
                          day: "numeric",
                        })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
