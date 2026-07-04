// レビュー束ね描画のグルーピング (QueueView から抽出した純ロジック)。
//
// 束ね描画: レビュー leaf(reviewOfId)が対象カードと同時にキューに見えるとき、
// 対象カードの直下にネスト描画する。並びはサーバ score 順の配列が唯一の真実のまま
// (束の位置=対象カードの位置。client は隣接描画のみで並べ替えない。
// docs/INVARIANTS.md「scoreItem の純度」)。対象がキューに居ない(畳み済み等)
// レビューは従来どおり単独カードで出る。

/** bundleReviews が参照する最小形 (QueueItem の部分集合)。 */
export interface BundleCard {
  id: string;
  reviewOfId?: string | null;
}

/**
 * カード列(サーバ score 順)からレビュー束を導出する。
 * - reviewsOf: 対象カード id → その直下にネスト描画するレビュー群(入力順を保存)。
 * - bundledIds: 束に吸収されたレビューの id 集合(単独カードとしては描画しない)。
 * 入力配列は変更しない・並べ替えない。
 */
export function bundleReviews<T extends BundleCard>(
  cards: T[],
): { reviewsOf: Map<string, T[]>; bundledIds: Set<string> } {
  const visibleIds = new Set(cards.map((q) => q.id));
  const reviewsOf = new Map<string, T[]>();
  for (const q of cards) {
    if (q.reviewOfId && visibleIds.has(q.reviewOfId)) {
      const arr = reviewsOf.get(q.reviewOfId) ?? [];
      arr.push(q);
      reviewsOf.set(q.reviewOfId, arr);
    }
  }
  const bundledIds = new Set([...reviewsOf.values()].flat().map((q) => q.id));
  return { reviewsOf, bundledIds };
}
