import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { copyText } from "./Bits.js";

// 端末の劇場 (REQUIREMENTS §4). ワンクリックでセッションの中身を眺める。
// 「眺める」= GUI内ライブビュー(WebSocketで capture-pane をストリーム)、
// 「張り付く」= 実端末アタッチコマンド。
// モバイル(タブのバックグラウンド化・回線切替)で WS は静かに切れるため、
// 切断を表示した上で指数バックオフ + visibilitychange 復帰で再接続する。

export function TerminalPane({ session }: { session: string | null }) {
  const [text, setText] = useState("(セッション未選択)");
  const [attachCmd, setAttachCmd] = useState("");
  const [disconnected, setDisconnected] = useState(false);
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session) return;
    setText("接続中…");
    setDisconnected(false);
    api.attachCommand(session).then((r) => setAttachCmd(r.command)).catch(() => {});

    let ws: WebSocket | null = null;
    let retryTimer: number | undefined;
    let stopped = false;
    let attempt = 0;

    const connect = () => {
      if (stopped) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(
        `${proto}://${location.host}/ws/terminal?session=${encodeURIComponent(session)}`,
      );
      ws.onopen = () => {
        attempt = 0;
        setDisconnected(false);
      };
      ws.onmessage = (ev) => {
        setText(ev.data);
        const box = boxRef.current;
        // 最下部付近にいるときだけ追従 (スクロールバック中は引き戻さない)。
        if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 48) {
          box.scrollTop = box.scrollHeight;
        }
      };
      ws.onerror = () => setText("(端末への接続に失敗。tmuxセッションが起動しているか確認)");
      ws.onclose = () => {
        if (stopped) return;
        setDisconnected(true);
        attempt += 1;
        retryTimer = window.setTimeout(connect, Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)));
      };
    };
    connect();

    // バックグラウンド復帰時は即再接続 (バックオフ待ちを飛ばす)。
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        !stopped &&
        (!ws || ws.readyState === WebSocket.CLOSED)
      ) {
        window.clearTimeout(retryTimer);
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      ws?.close();
    };
  }, [session]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <strong>{session ?? "—"}</strong>
        {attachCmd && (
          <button
            onClick={async () => {
              setCopied((await copyText(attachCmd)) ? "ok" : "fail");
            }}
            title="実端末でアタッチするコマンドをコピー"
            aria-label="実端末でアタッチするコマンドをコピー"
          >
            実端末で開く（コマンドをコピー）
          </button>
        )}
        {copied === "ok" && <span className="muted">コピーしました</span>}
        {copied === "fail" && (
          <span className="muted">コピーできませんでした。下のコマンドを長押しで選択してください</span>
        )}
        {disconnected && <span className="muted">（切断されました — 再接続中…）</span>}
      </div>
      {/* role=log だが aria-live は付けない: 端末更新を SR が読み上げ続けないように。 */}
      <div className="term" role="log" ref={boxRef}>
        {text}
      </div>
      {attachCmd && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{attachCmd}</div>}
    </div>
  );
}
