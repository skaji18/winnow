import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

// 端末の劇場 (REQUIREMENTS §4). ワンクリックでセッションの中身を眺める。
// 「眺める」= GUI内ライブビュー(WebSocketで capture-pane をストリーム)、
// 「張り付く」= 実端末アタッチコマンド。

export function TerminalPane({ session }: { session: string | null }) {
  const [text, setText] = useState("(セッション未選択)");
  const [attachCmd, setAttachCmd] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session) return;
    setText("接続中…");
    api.attachCommand(session).then((r) => setAttachCmd(r.command)).catch(() => {});

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${location.host}/ws/terminal?session=${encodeURIComponent(session)}`,
    );
    ws.onmessage = (ev) => {
      setText(ev.data);
      const box = boxRef.current;
      if (box) box.scrollTop = box.scrollHeight;
    };
    ws.onerror = () => setText("(端末への接続に失敗。tmuxセッションが起動しているか確認)");
    return () => ws.close();
  }, [session]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <strong>{session ?? "—"}</strong>
        {attachCmd && (
          <button
            onClick={() => navigator.clipboard?.writeText(attachCmd)}
            title="実端末でアタッチするコマンドをコピー"
            aria-label="実端末でアタッチするコマンドをコピー"
          >
            実端末で開く（コマンドをコピー）
          </button>
        )}
      </div>
      {/* role=log だが aria-live は付けない: 端末更新を SR が読み上げ続けないように。 */}
      <div className="term" role="log" ref={boxRef}>
        {text}
      </div>
      {attachCmd && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{attachCmd}</div>}
    </div>
  );
}
