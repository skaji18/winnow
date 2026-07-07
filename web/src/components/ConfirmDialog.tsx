import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// ネイティブ window.confirm/alert の代替 (docs/DECISIONS.md「ネイティブダイアログの廃止」)。
// 一部ブラウザ/組み込み WebView はダイアログを抑制して confirm が常に false を返すため、
// 確認つき操作が「押しても無反応」に見える。自前 alertdialog に置き換えて抑制の影響を断つ。
// 使い方: App 直下に <ConfirmHost> を1つ置き、呼び出し側は useConfirm() で
// `if (!(await confirmDialog({...}))) return;` とする (Promise<boolean>)。

export interface ConfirmOptions {
  title: string;
  body?: string;
  /** 既定 "OK" */
  okLabel?: string;
  /** 既定 "やめる" */
  cancelLabel?: string;
  /** 破壊的操作: OK ボタンを danger スタイルに (既定は primary)。 */
  danger?: boolean;
  /** alert 相当: OK のみ表示し、閉じ方によらず true で解決する。 */
  infoOnly?: boolean;
}

type Ask = (opts: ConfirmOptions) => Promise<boolean>;

// 既定値は「常にキャンセル」: Host の外から呼ばれた場合に操作が黙って進む方向へ倒さない。
const ConfirmContext = createContext<Ask>(() => Promise.resolve(false));

export function useConfirm(): Ask {
  return useContext(ConfirmContext);
}

interface Pending {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function ConfirmHost({ children }: { children: ReactNode }) {
  // 同時要求はキューで直列化する (先頭のみ表示。後続は前が閉じてから出る)。
  const [queue, setQueue] = useState<Pending[]>([]);
  const current = queue[0] ?? null;
  const ask = useCallback<Ask>(
    (opts) => new Promise<boolean>((resolve) => setQueue((q) => [...q, { opts, resolve }])),
    [],
  );

  // フォーカス管理: 開いたら安全側 (キャンセル。infoOnly は OK) へ移し、閉じたら元へ戻す。
  const initialFocusRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!current) return;
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    initialFocusRef.current?.focus();
    return () => {
      restoreRef.current?.focus?.();
    };
  }, [current]);

  const settle = (ok: boolean) => {
    if (!current) return;
    // alert 相当は「読んだ」以外の結果を持たない: Escape/背面クリックでも true。
    current.resolve(current.opts.infoOnly ? true : ok);
    setQueue((q) => q.slice(1));
  };

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {current && (
        <div className="modal-backdrop confirm-backdrop" onClick={() => settle(false)}>
          <div
            className="modal confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby={current.opts.body ? "confirm-dialog-body" : undefined}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") settle(false);
            }}
          >
            <h3 id="confirm-dialog-title" style={{ marginTop: 0 }}>
              {current.opts.title}
            </h3>
            {current.opts.body && (
              <p id="confirm-dialog-body" className="confirm-body">
                {current.opts.body}
              </p>
            )}
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              {!current.opts.infoOnly && (
                <button ref={initialFocusRef} onClick={() => settle(false)}>
                  {current.opts.cancelLabel ?? "やめる"}
                </button>
              )}
              <button
                ref={current.opts.infoOnly ? initialFocusRef : undefined}
                className={current.opts.danger ? "danger" : "primary"}
                onClick={() => settle(true)}
              >
                {current.opts.okLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
