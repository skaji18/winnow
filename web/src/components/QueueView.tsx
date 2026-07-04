import { useEffect, useState } from "react";
import { applyFilter, emptyFilter, FilterBar, filterIsEmpty, type FilterState } from "./FilterBar.js";
import { DecomposeModal } from "./DecomposeModal.js";
import { HorizonLens } from "./HorizonLens.js";
import { ProjectLanes } from "./ProjectLanes.js";
import { QueueCard } from "./QueueCard.js";
import { bundleReviews } from "../lib/review-bundle.js";
import type { AppState, QueueItem } from "../types.js";

// ---------------------------------------------------------------------------
// キュー: 火の海ではなくエスカレーションだけの短いキュー (§4)
// ---------------------------------------------------------------------------
// 実績ゼロ(初日)判定の閾値。LabelEvent 総数がこれ未満なら cold-banner 初日を第一級表示。
const COLD_THRESHOLD = 10;

export function QueueView({ state, onChange }: { state: AppState; onChange: () => void }) {
  // id だけ保持し、表示直前に live state から引き直す。これでポーリングで decomposeStatus が
  // running→ready と動いてもモーダルが古いスナップショットに固定されない。
  const [decomposeForId, setDecomposeForId] = useState<string | null>(null);
  const decomposeFor = decomposeForId
    ? (state.items.find((i) => i.id === decomposeForId) ?? null)
    : null;
  const [filter, setFilter] = useState<FilterState>(emptyFilter);
  const [filterOpen, setFilterOpen] = useState(false);
  // 俯瞰レンズ: 既存キューの groupBy トグル (別画面を作らない)。flat=現行挙動を完全温存。
  // project=案件レーン(+未所属Inbox) / horizon=rung×due の中長期見通し。
  const [groupBy, setGroupBy] = useState<"flat" | "project" | "horizon">("flat");

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

      {/* 俯瞰レンズの切替 (FilterBar とは別軸の純フロント状態)。処理量メトリクスは出さない。
          検索トグルはタッチ到達性のため常設 ('/' はキーボード専用でモバイルから到達不能だった)。 */}
      <div className="queue-toolbar">
        <div className="lens-toggle" role="group" aria-label="俯瞰レンズ">
          {([
            ["flat", "まとめない"],
            ["project", "案件"],
            ["horizon", "見通し"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              className={groupBy === key ? "active" : ""}
              aria-pressed={groupBy === key}
              onClick={() => setGroupBy(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="filter-toggle"
          aria-pressed={filterOpen}
          onClick={() => {
            if (filterOpen) {
              // 閉じるときは FilterBar の onClose と同じ扱い (絞り込みも解除)。
              setFilterOpen(false);
              setFilter(emptyFilter());
            } else {
              setFilterOpen(true);
            }
          }}
        >
          検索 / 絞り込み
        </button>
      </div>

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

      {/* horizon レンズはキュー(エスカレ)とは別母集団(全 open 項目)の見通しなので、
          キュー空判定に関係なく専用描画する。 */}
      {groupBy === "horizon" ? (
        <HorizonLens cells={state.horizon} />
      ) : visible.length === 0 ? (
        <div className="empty">
          {filterIsEmpty(filter)
            ? "キューは空です。新しいアイテムを登録すると分類されます。"
            : "絞り込み条件に一致するアイテムはありません。"}
        </div>
      ) : (
        <>
          {/* さばく場(キュー)。仕分けと処分を行う面。flat=現行 / project=案件レーン。 */}
          {(() => {
            const queueCards = visible.filter((q) => q.lane !== "in_progress");
            // 束ね描画のグルーピングは lib/review-bundle.ts (client は隣接描画のみで並べ替えない)。
            const { reviewsOf, bundledIds } = bundleReviews(queueCards);
            const renderCard = (q: QueueItem) => {
              if (bundledIds.has(q.id)) return null; // 対象カード側の束で描画済み
              const card = (
                <QueueCard
                  item={q}
                  state={state}
                  learning={learning}
                  onChange={onChange}
                  onDecompose={() => setDecomposeForId(q.id)}
                />
              );
              const reviews = reviewsOf.get(q.id) ?? [];
              if (reviews.length === 0) return <div key={q.id}>{card}</div>;
              return (
                <div key={q.id}>
                  {card}
                  <div className="review-bundle">
                    <div className="muted" style={{ fontSize: 12, margin: "4px 0" }}>
                      └ この実行結果のレビュー
                    </div>
                    {reviews.map((r) => (
                      <QueueCard
                        key={r.id}
                        item={r}
                        state={state}
                        learning={learning}
                        onChange={onChange}
                        onDecompose={() => setDecomposeForId(r.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            };
            if (groupBy === "project") {
              return <ProjectLanes cards={queueCards} state={state} renderCard={renderCard} />;
            }
            return queueCards.map(renderCard);
          })()}
          {/* 着手中レーン: 自分で引き取ったタスク。ここから直接「完了/手放す」で閉じられる
              (案件/スプリントのボードに乗っていなくても完了できる継ぎ目)。件数つきで折り畳み可
              (native details=キーボード/SR対応)。溜まっても短いキューを圧迫しすぎないよう畳める。 */}
          {(() => {
            const inProg = visible.filter((q) => q.lane === "in_progress");
            if (inProg.length === 0) return null;
            return (
              <details className="lane-section" open>
                <summary className="lane-head">
                  <b>着手中 {inProg.length}件</b>（自分で対応中。ここで完了にできます）
                </summary>
                {inProg.map((q) => (
                  <QueueCard
                    key={q.id}
                    item={q}
                    state={state}
                    learning={learning}
                    onChange={onChange}
                    onDecompose={() => setDecomposeForId(q.id)}
                  />
                ))}
              </details>
            );
          })()}
        </>
      )}

      {decomposeFor && (
        <DecomposeModal
          key={decomposeFor.id}
          item={decomposeFor}
          onClose={() => setDecomposeForId(null)}
          onChange={onChange}
        />
      )}
    </>
  );
}
