import { useState } from "react";
import { api } from "../api.js";
import { useLive } from "../live.js";
import type { UpdateState } from "../types.js";

// 自己更新バナー (DECISIONS「自己更新」節)。検知結果の案内と適用のワンタップだけを持つ。
// 適用中はフェーズを映す。サーバは vite build 後に exit → supervisor が新版で上げ直し →
// bootId 変化で App が自動再読込するので、ここで完了を検知する必要はない。
const APPLY_PHASE_LABEL: Record<string, string> = {
  fetching: "取得中",
  installing: "依存導入中",
  building: "ビルド中",
  restarting: "再起動中",
};
export function UpdateBanner({
  update,
  version,
  onChange,
}: {
  update: UpdateState;
  version?: string;
  onChange: () => void;
}) {
  const live = useLive();
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const phase = update.apply.phase;
  if (phase !== "idle" && phase !== "failed") {
    return (
      <div className="cold-banner" role="status">
        更新を適用中（{APPLY_PHASE_LABEL[phase] ?? phase}）…
        完了するとサーバは終了し、常駐(supervisor)運用なら新版で自動再起動→このページも
        自動再読込されます。手動起動の場合は npm start で上げ直してください。
      </div>
    );
  }
  // 適用失敗の痕跡は available と独立に出す (新版が取り下げられて available が false に
  // 戻っても、直前の失敗を黙って消さない)。
  const applyError = phase === "failed" ? update.apply.error : null;
  if (!update.available && !applyError && !failMsg) return null;
  const apply = async () => {
    // 実行中ジョブ・dirty tree 等の最終ゲートはサーバ側 (started:false + reason)。
    if (!window.confirm(`${update.latestTag} に更新してサーバを再起動します。よろしいですか？`))
      return;
    try {
      const r = await api.applyUpdate();
      if (r.started) {
        setFailMsg(null);
        live("更新を開始しました");
      } else {
        setFailMsg(r.reason ?? "更新を開始できませんでした");
      }
      onChange();
    } catch (e) {
      setFailMsg((e as Error).message);
    }
  };
  // エラー表示は1本に畳む (ローカルの開始拒否 > 直前の適用失敗の順で新しい方)。
  const errLine = failMsg ?? (applyError ? `前回の適用が失敗: ${applyError}` : null);
  return (
    <div className="cold-banner" role="status">
      {update.available && (
        <>
          新しいバージョン {update.latestTag}
          {version ? `（現在 v${version}）` : ""} → <button onClick={apply}>更新して再起動</button>
          {update.url && (
            <>
              {" "}
              <a href={update.url} target="_blank" rel="noreferrer">
                リリースノート
              </a>
            </>
          )}
        </>
      )}
      {errLine && <span className="muted"> {errLine}</span>}
    </div>
  );
}
