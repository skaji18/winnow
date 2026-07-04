import { useEffect, useMemo, useRef, useState } from "react";
import { api, type DecomposeOption } from "../api.js";
import { useLive } from "../live.js";
import type { Item } from "../types.js";
import { RUNG_LABEL } from "../types.js";

// ---------------------------------------------------------------------------
export function DecomposeModal({
  item,
  onClose,
  onChange,
}: {
  item: Item;
  onClose: () => void;
  onChange: () => void;
}) {
  const live = useLive();
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // item.id ごとに分解リクエストを1回だけ発火させる ref ガード(StrictMode 二重起動・再レンダ対策)。
  const kickedFor = useRef<string | null>(null);
  // aria-live の重複読み上げ抑止(同じ局面を何度も読まない)。
  const announced = useRef<string>("");
  // a11y: 初期 focus(閉じるボタン)と、閉じたら発火元へ focus 復帰。
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = `decompose-title-${item.id}`;

  // 進捗・結果は item(ポーリングで更新される live state)から導出する。モーダルは fetch を
  // 所有しない=閉じても分解は続く・再オープンで decomposeOptions から即表示。
  const status = item.decomposeStatus ?? "none";
  const options = useMemo<DecomposeOption[] | null>(() => {
    if (status !== "ready" || !item.decomposeOptions) return null;
    try {
      return JSON.parse(item.decomposeOptions) as DecomposeOption[];
    } catch {
      return null;
    }
  }, [status, item.decomposeOptions]);
  // none=点火待ち/直後、running=分解中。どちらも「待っている」局面として扱う。
  const waiting = status === "none" || status === "running";
  // failed、または ready なのに候補が空/壊れている=やり直しが要る局面。
  const needsRetry = status === "failed" || (status === "ready" && (!options || options.length === 0));

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    return () => {
      opener?.focus?.();
    };
  }, []);

  // 未分解(none)で開かれたら分解を背景発火。結果はポーリングで受け取る(戻り値は使わない)。
  useEffect(() => {
    if (status === "none" && kickedFor.current !== item.id) {
      kickedFor.current = item.id;
      api.decompose(item.id).catch(() => {});
    }
  }, [item.id, status]);

  // 経過タイマー: 待機中だけ動かす。バックエンドは進捗を出さない(dispatch は単発)ので、
  // 経過秒だけが唯一“嘘でない”動く信号。% は出さない。
  useEffect(() => {
    if (!waiting) return;
    setElapsed(0);
    const t0 = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [waiting]);

  // 状態遷移を単一 aria-live 領域へ読み上げ(視覚と同期・重複抑止)。
  useEffect(() => {
    const key = waiting ? "waiting" : options && options.length ? "ready" : needsRetry ? "retry" : "";
    if (!key || announced.current === key) return;
    announced.current = key;
    if (key === "waiting") live("AIが割り方を考えています");
    else if (key === "ready") live(`割り方の候補が ${options?.length ?? 0}件 揃いました`);
    else if (key === "retry") live("分解に失敗しました。再試行できます");
  }, [waiting, options, needsRetry, live]);

  const apply = async (opt: DecomposeOption) => {
    setApplying(true);
    setApplyError(null);
    try {
      await api.applyDecompose(item.id, opt);
      await onChange();
      onClose();
    } catch (e) {
      // 失敗を可視化しないと unhandled rejection でモーダルが開いたままになり、
      // 再タップ=サーバ側で子アイテムの二重生成を誘う。
      setApplyError((e as Error).message);
      live("割り当てに失敗しました");
    } finally {
      setApplying(false);
    }
  };

  // 再試行: 失敗/空から分解をもう一度発火。読み上げ済みフラグも戻す。
  const retry = () => {
    kickedFor.current = item.id;
    announced.current = "";
    api.decompose(item.id).catch(() => {});
  };

  // タッチでモーダル内をスクロール中、指が縁の backdrop に触れただけで閉じる事故を防ぐ:
  // mousedown/up (タップの開始と終了) が共に backdrop 上のときだけ閉じる。
  const downOnBackdrop = useRef(false);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="row" style={{ marginBottom: 12 }}>
          <h3 id={titleId} style={{ margin: 0, flex: 1 }}>
            分解: {item.title}
          </h3>
          <button ref={closeBtnRef} onClick={onClose}>
            閉じる
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12.5 }}>
          割り方の選択肢。サイクル長は不確実性に反比例（不明な段はPoCで情報を買う短サイクル §2.3）。
        </p>
        {applyError && (
          <div className="cold-banner" role="alert" style={{ marginBottom: 8 }}>
            割り当てに失敗しました: {applyError}
          </div>
        )}
        {waiting && <DecomposeWaiting elapsed={elapsed} />}
        {needsRetry && (
          <div className="actions" style={{ marginTop: 4, flexWrap: "wrap" }}>
            <div
              className="cold-banner"
              role="alert"
              style={{ flexBasis: "100%", marginBottom: 8 }}
            >
              {status === "failed"
                ? "分解に失敗しました。AI セッションが混んでいるか、応答を解釈できませんでした。"
                : "今回は割り方の提案が得られませんでした。"}
            </div>
            <button className="primary" onClick={retry}>
              再試行
            </button>
          </div>
        )}
        {options?.map((opt, i) => (
          <div className="option-card" key={i}>
            <div className="row">
              <strong style={{ flex: 1 }}>{opt.label}</strong>
              <span className="badge">{opt.process === "iterative" ? "反復" : "一括"}</span>
              <button className="primary" disabled={applying} onClick={() => apply(opt)}>
                この割り方で作る
              </button>
            </div>
            <div className="reason">{opt.rationale}</div>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {opt.children.map((c, j) => (
                <li key={j} style={{ fontSize: 12.5, marginBottom: 6 }}>
                  <span className="muted">
                    {c.kind === "leaf" ? "▸" : "◆"} {c.title}{" "}
                    <span className="badge kind">{RUNG_LABEL[c.rung]}</span>
                    {c.projectDir && (
                      <span className="badge" title={c.projectDir}>
                        📁 {c.projectDir.split("/").pop() || c.projectDir}
                      </span>
                    )}
                  </span>
                  {c.spec && (
                    <details style={{ marginLeft: 14, marginTop: 2 }}>
                      <summary className="muted" style={{ fontSize: 11.5, cursor: "pointer" }}>
                        詳細 / spec を見る
                      </summary>
                      <div
                        className="muted"
                        style={{ fontSize: 11.5, opacity: 0.85, whiteSpace: "pre-wrap", marginTop: 4 }}
                      >
                        {c.spec}
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

// 分解の待機表示: 経過秒(唯一の正直な動く信号)+ 結果が降る場所を示すスケルトン。
// 「閉じても続く」ことを明記し、フリーズではなく作業中だと伝える (§3.3, §4)。
function DecomposeWaiting({ elapsed }: { elapsed: number }) {
  return (
    <div className="decompose-wait">
      <p className="spinner" style={{ marginBottom: 2 }}>
        AIが割り方を考えています…
      </p>
      <p className="muted" style={{ fontSize: 11.5, margin: "0 0 10px" }}>
        経過 {elapsed}秒 ／ 通常は数十秒かかります。閉じても分解は続きます（あとで開き直すと結果が出ています）。
      </p>
      <div aria-hidden="true">
        {[0, 1, 2].map((n) => (
          <div className="option-card skeleton" key={n}>
            <div className="skel-line" style={{ width: "42%" }} />
            <div className="skel-line" style={{ width: "78%" }} />
            <div className="skel-line short" style={{ width: "60%" }} />
          </div>
        ))}
      </div>
    </div>
  );
}
