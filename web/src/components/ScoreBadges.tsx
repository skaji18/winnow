import type { Item } from "../types.js";
import { DISPOSITION_LABEL, REVERSIBILITY_LABEL, RUNG_LABEL, STAKES_LABEL } from "../types.js";

// 理由はグランス可能に (REQUIREMENTS §4-2). 一行＋スコアバッジで「目に入る」。
// 確信度は必ず出す(出さないと全件裏取りされて終わる)。

export function ScoreBadges({
  item,
  learning = false,
}: {
  item: Item;
  // 学習中(実績ゼロ)で安全側に倒れた escalate を正常 escalate と視覚区別する (点線枠)。
  learning?: boolean;
}) {
  return (
    <div className="badges">
      <span className="badge kind">
        {item.kind === "node" ? `親・${RUNG_LABEL[item.rung]}` : RUNG_LABEL[item.rung]}
      </span>
      {item.disposition && (
        <span
          className={`badge disp-${item.disposition}${
            learning && item.disposition === "escalate" ? " learning" : ""
          }`}
          title={
            learning && item.disposition === "escalate"
              ? "学習中のため安全側に保留"
              : undefined
          }
        >
          {DISPOSITION_LABEL[item.disposition]}
          {learning && item.disposition === "escalate" && (
            <span className="sr-only">（学習中・安全側保留）</span>
          )}
        </span>
      )}
      <Confidence value={item.confidence} />
    </div>
  );
}

export function Confidence({ value }: { value: number | null }) {
  const v = value ?? 0;
  const pct = Math.round(v * 100);
  // 閾値色分け: 高(>=80)/中(>=50)/低。色だけに頼らず数値も併記。
  const level = v >= 0.8 ? "high" : v >= 0.5 ? "mid" : "low";
  return (
    <span
      className="conf-wrap"
      title="確信度"
      role="progressbar"
      aria-label="確信度"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="conf-bar">
        <span className={`conf-fill ${level}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="conf-num">{pct}%</span>
    </span>
  );
}

export function MiniScores({ item }: { item: Item }) {
  const pct = (n: number | null) => (n == null ? "–" : `${Math.round(n * 100)}%`);
  return (
    <div className="mini-scores">
      <span>
        ステークス{" "}
        <b>
          {STAKES_LABEL(item.stakes)}（{pct(item.stakes)}）
        </b>
      </span>
      <span>
        可逆性{" "}
        <b>
          {REVERSIBILITY_LABEL(item.reversibility)}（{pct(item.reversibility)}）
        </b>
      </span>
      {item.category && (
        <span>
          区分 <b>{item.category}</b>
        </span>
      )}
      {item.process && <span>{item.process === "iterative" ? "反復" : "一括"}</span>}
    </div>
  );
}
