import type { Item } from "../types.js";

// 「完了にする」の PATCH ペイロード組み立て (DECISIONS「人間実施の結果の下流受け渡し」書き込み口(UI))。
// - 非空(trim後)なら単一 PATCH { status:'done', resolution } + expectedUpdatedAt(楽観ロック)。
//   結果を書いた完了は「その時点の item を見て書いた」ので、他所の同時更新は 409 で弾いて
//   入力保持へ回す(黙った全列上書きの巻き戻り防止)。
// - 空なら resolution キー自体を送らない = 従来の完了経路と一字一句同一(完全縮退)。
//   expectedUpdatedAt も付けない — 従来「完了にする」は楽観ロック無しで通っており、
//   何も書いていない完了まで 409 で弾き始めると挙動が変わる。
export function buildDonePatch(
  resolutionDraft: string,
  updatedAt: number,
): { patch: Partial<Item>; expectedUpdatedAt?: number } {
  const t = resolutionDraft.trim();
  return t
    ? { patch: { status: "done", resolution: t }, expectedUpdatedAt: updatedAt }
    : { patch: { status: "done" } };
}
