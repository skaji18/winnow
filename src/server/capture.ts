// 捕獲サービス (REQUIREMENTS §4 利用動線 / §3.1). 「雑に貼る入口」の唯一の実体。
// POST /api/items ハンドラと MCP の winnow_capture ツールが、この同じ関数を通る。
// 入口が増えても「登録 → 分類器が仕分け」の一本道は変えない (背骨 §1.3 / §5)。
import { z } from "zod";
import { classify } from "./classifier.js";
import type { Item } from "./domain.js";
import { validateProjectDir } from "./paths.js";
import { items, settings } from "./repo.js";
import { provisionalTitle } from "./text.js";

// 仕分け等の長い AI op はバックグラウンドで回す (UI/呼び出し側は待たない)。
function background(fn: () => Promise<unknown>): void {
  fn().catch((e) => console.error("[winnow] background op failed:", e));
}

// 「雑に貼る」捕獲スキーマ: title は任意。本文(会話ログ/メモ)だけでもよく、
// title 未指定なら本文先頭から暫定タイトルを派生する。title か body のどちらかは必須。
export const captureSchema = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
    parentId: z.string().nullable().optional(),
    kind: z.enum(["node", "leaf"]).optional(),
    domain: z.enum(["software", "general"]).optional(),
    projectDir: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    sprintId: z.string().nullable().optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    dueDate: z.number().nullable().optional(),
    classify: z.boolean().optional(),
    // 外部冪等キー (重複取り込み防止)。同一 externalKey の再 capture は no-op/追記になる。
    externalKey: z.string().min(1).optional(),
    // 原典へ戻るリンク (read-only 痕跡。winnow は外部送出しない)。
    sourceUrl: z.string().url().optional(),
  })
  .refine((d) => Boolean(d.title?.trim() || d.body?.trim()), {
    message: "title か body のいずれかが必要です",
  });

export type CaptureInput = z.infer<typeof captureSchema>;

/**
 * アイテムを1件登録し、(classify:false でなければ) 分類器を非同期で発火する。
 * UI をバイパスした登録でも壊れないよう、title 未指定なら本文先頭から暫定タイトルを派生する。
 * 同期 SQLite 書き込みなので、戻り値が返る時点でアイテムは確実に永続化済み。
 */
export function captureItem(input: CaptureInput): Item {
  // (1) 冪等キー: 同一 externalKey の既存があれば重複作成せず、body が来ていれば追記して
  //     既存 Item を返す(no-op 同然)。再分類は発火しない(取り込み再投入で分類器を溢れさせない)。
  if (input.externalKey) {
    const existing = items.findByExternalKey(input.externalKey);
    if (existing) {
      if (input.body?.trim()) {
        return (
          items.update(existing.id, {
            body: `${existing.body}\n\n---\n${input.body}`,
          }) ?? existing
        );
      }
      return existing;
    }
  }

  // (2) projectDir 検証: 不正(相対パス/機微パス)は拒否でなく projectDir=null で作成しつつ、
  //     後段 classify が escalate 寄りに倒れるよう body 末尾へ注記(背骨: 失敗は安全側に倒す)。
  let projectDir = input.projectDir ?? null;
  let escalateNote = "";
  if (input.projectDir != null && input.projectDir.trim() !== "") {
    const v = validateProjectDir(input.projectDir);
    projectDir = v.dir;
    if (v.escalate) {
      escalateNote = `\n\n[winnow] 注意: 渡された作業ディレクトリを安全側で無効化しました(${v.reason ?? "検証失敗"})。実行前に人間が確認してください。`;
    }
  }

  const title = input.title?.trim() || provisionalTitle(input.body ?? "");
  const item = items.create({
    title,
    body: (input.body ?? "") + escalateNote,
    parentId: input.parentId ?? null,
    kind: input.kind ?? "node",
    domain: input.domain ?? "general",
    projectDir,
    projectId: input.projectId ?? null,
    sprintId: input.sprintId ?? null,
    priority: input.priority ?? "normal",
    dueDate: input.dueDate ?? null,
    sourceUrl: input.sourceUrl ?? null,
    externalKey: input.externalKey ?? null,
  });

  // (3) 過負荷バックプレッシャ: 未さばき(disposition=null かつ inbox/classified)が
  //     captureInboxHoldThreshold を超えていたら classify を発火せず inbox 保留にする
  //     (reject/escalate でなくバックプレッシャ。開封時 /api/state sweep でドレインされる)。
  const cfg = settings.get();
  const pending = items
    .all()
    .filter(
      (it) =>
        it.disposition === null && (it.status === "inbox" || it.status === "classified"),
    ).length;
  const overloaded = cfg.captureInboxHoldThreshold > 0 && pending >= cfg.captureInboxHoldThreshold;

  // 新規アイテムが着いたら分類器が disposition を書く (§4 利用動線)。過負荷時は保留。
  if (input.classify !== false && !overloaded) background(() => classify(item.id));
  return item;
}
