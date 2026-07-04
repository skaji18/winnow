// general 成果物の summary/output 分離 (QueueCard から抽出した純ロジック §3.4)。
import type { Item } from "../types.js";

/**
 * executionSummary/Output があればそれを優先、無ければ executionResult を
 * `summary\n\noutput` で分割(executor の連結形)。戻り値は [summary, output]。
 */
export function splitExecutionResult(
  item: Pick<Item, "executionResult" | "executionSummary" | "executionOutput">,
): [summary: string, output: string] {
  if (item.executionSummary != null || item.executionOutput != null) {
    return [item.executionSummary ?? "", item.executionOutput ?? ""];
  }
  const r = item.executionResult ?? "";
  const parts = r.split(/\n\n/);
  return [parts[0] ?? "", parts.slice(1).join("\n\n")];
}
