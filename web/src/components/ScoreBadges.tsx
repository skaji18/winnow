import type { Item } from "../types.js";
import { DISPOSITION_LABEL, RUNG_LABEL } from "../types.js";

// 理由はグランス可能に (REQUIREMENTS §4-2). 一行＋スコアバッジで「目に入る」。
// 確信度は必ず出す(出さないと全件裏取りされて終わる)。

export function ScoreBadges({ item }: { item: Item }) {
  return (
    <div className="badges">
      <span className="badge kind">
        {item.kind === "node" ? `親・${RUNG_LABEL[item.rung]}` : RUNG_LABEL[item.rung]}
      </span>
      {item.disposition && (
        <span className={`badge disp-${item.disposition}`}>
          {DISPOSITION_LABEL[item.disposition]}
        </span>
      )}
      <Confidence value={item.confidence} />
    </div>
  );
}

export function Confidence({ value }: { value: number | null }) {
  const v = value ?? 0;
  return (
    <span className="conf-wrap" title="確信度">
      <span className="conf-bar">
        <span className="conf-fill" style={{ width: `${Math.round(v * 100)}%` }} />
      </span>
      <span className="conf-num">{Math.round(v * 100)}%</span>
    </span>
  );
}

export function MiniScores({ item }: { item: Item }) {
  const pct = (n: number | null) => (n == null ? "–" : `${Math.round(n * 100)}%`);
  return (
    <div className="mini-scores">
      <span>
        ステークス <b>{pct(item.stakes)}</b>
      </span>
      <span>
        可逆性 <b>{pct(item.reversibility)}</b>
      </span>
      {item.category && (
        <span>
          区分 <b>{item.category}</b>
        </span>
      )}
      {item.process && (
        <span>{item.process === "iterative" ? "反復" : "一括"}</span>
      )}
    </div>
  );
}
