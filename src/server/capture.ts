// 捕獲サービス (REQUIREMENTS §4 利用動線 / §3.1). 「雑に貼る入口」の唯一の実体。
// POST /api/items ハンドラと MCP の winnow_capture ツールが、この同じ関数を通る。
// 入口が増えても「登録 → 分類器が仕分け」の一本道は変えない (背骨 §1.3 / §5)。
import { z } from "zod";
import { classify } from "./classifier.js";
import type { Item } from "./domain.js";
import { items } from "./repo.js";
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
  const title = input.title?.trim() || provisionalTitle(input.body ?? "");
  const item = items.create({
    title,
    body: input.body ?? "",
    parentId: input.parentId ?? null,
    kind: input.kind ?? "node",
    domain: input.domain ?? "general",
    projectDir: input.projectDir ?? null,
    projectId: input.projectId ?? null,
    sprintId: input.sprintId ?? null,
    priority: input.priority ?? "normal",
    dueDate: input.dueDate ?? null,
  });
  // 新規アイテムが着いたら分類器が disposition を書く (§4 利用動線)。
  if (input.classify !== false) background(() => classify(item.id));
  return item;
}
