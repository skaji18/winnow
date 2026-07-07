import { useState } from "react";
import { api } from "../api.js";
import { parseDate, provisionalTitle } from "./Bits.js";
import { Select } from "./Select.js";
import type { AppState, Priority } from "../types.js";

// ---------------------------------------------------------------------------
export function AddItem({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [domain, setDomain] = useState<"software" | "general">("general");
  const [projectDir, setProjectDir] = useState("");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [due, setDue] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const raw = body.trim();
    const typed = title.trim();
    if (!raw && !typed) return;
    // 「雑に貼る」: タイトル未記入なら本文から派生する。
    //  - 一行タスク(改行なし・短い)はそれ自体をタイトルにし本文は空(重複させない)。
    //  - 会話ログ/メモの貼り付けは先頭から暫定タイトルを作り、全文は本文に残す。
    //    暫定タイトルは分類時にAIの要約見出しで上書きされる(サーバ側)。
    let finalTitle = typed;
    let finalBody = raw;
    if (!finalTitle) {
      const oneLiner = !raw.includes("\n") && raw.length <= 80;
      if (oneLiner) {
        finalTitle = raw;
        finalBody = "";
      } else {
        finalTitle = provisionalTitle(raw);
      }
    }
    setBusy(true);
    try {
      await api.createItem({
        title: finalTitle,
        body: finalBody,
        domain,
        projectDir: domain === "software" && projectDir.trim() ? projectDir.trim() : null,
        projectId: projectId || null,
        priority,
        dueDate: parseDate(due),
      });
      setTitle("");
      setBody("");
      setProjectDir("");
      setDue("");
      setPriority("normal");
      setOpen(false);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="add-form">
        {/* 本文(会話ログ/メモ)を主役に。雑に貼るだけで登録できる(新規儀式ゼロ §3.1)。 */}
        <textarea
          placeholder="会話・メモ・タスクを雑に貼る（タイトルは空でOK）"
          value={body}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()}
        />
        <div className="row">
          <span className="muted" style={{ flex: 1, fontSize: "0.85em" }}>
            大きい塊は1件のまま「要確認」で残ります。割るかどうかはあなたが決めます。
          </span>
          <button className="primary" disabled={busy} onClick={submit}>
            登録して分類
          </button>
          <button onClick={() => setOpen((o) => !o)}>{open ? "詳細を閉じる" : "詳細"}</button>
        </div>
        {open && (
          <>
            <input
              type="text"
              placeholder="タイトル（空なら本文先頭から自動。AIが要約で差し替え）"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="row">
              <label className="muted">
                案件:{" "}
                <Select
                  value={projectId}
                  onChange={setProjectId}
                  ariaLabel="案件"
                  options={[
                    { value: "", label: "なし" },
                    // アーカイブ案件は登録先に出さない (気づかず登録→全面で畳まれて誰にも
                    // 見られない、を防ぐ。復元すれば選べる)。
                    ...state.projects
                      .filter((p) => p.status !== "archived")
                      .map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
              </label>
              <label className="muted">
                優先度:{" "}
                <Select
                  value={priority}
                  onChange={(v) => setPriority(v as Priority)}
                  ariaLabel="優先度"
                  options={[
                    { value: "urgent", label: "緊急" },
                    { value: "high", label: "高" },
                    { value: "normal", label: "中" },
                    { value: "low", label: "低" },
                  ]}
                />
              </label>
              <label className="muted">
                期日: <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
              </label>
            </div>
            <div className="row">
              <label className="muted">
                領域:{" "}
                <Select
                  value={domain}
                  onChange={(v) => setDomain(v as "software" | "general")}
                  ariaLabel="領域"
                  options={[
                    { value: "general", label: "一般" },
                    { value: "software", label: "ソフト開発" },
                  ]}
                />
              </label>
              {domain === "software" && (
                <input
                  type="text"
                  placeholder="作業ディレクトリ (例: /home/you/project)"
                  value={projectDir}
                  onChange={(e) => setProjectDir(e.target.value)}
                  style={{ flex: 1 }}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
