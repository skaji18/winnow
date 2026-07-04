// 処分=ラベル Undo(直近1手の逆適用)のボタン文言 (App.tsx から移設)。
// 未知 action はそのまま返す(サーバが語彙を増やしても壊れない)。
export function undoLabelText(action: string): string {
  switch (action) {
    case "do":
      return "着手";
    case "reject":
      return "却下";
    case "send_back":
      return "問いに戻す";
    case "reclassify":
    case "override":
      return "分類し直し";
    case "mute_category":
      return "この種類を自動化";
    case "receive":
      return "受領・畳み";
    default:
      return action;
  }
}
