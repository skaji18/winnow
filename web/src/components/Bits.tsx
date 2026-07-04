import type { Disposition, Item, Project, Sprint } from "../types.js";
import { DISPOSITION_LABEL, PRIORITY_LABEL } from "../types.js";

// カード/ビュー共通の小物バッジ。期日・優先度・案件をグランス可能に出す。

export function PriorityBadge({ priority }: { priority: Item["priority"] }) {
  if (priority === "normal") return null;
  return <span className={`badge prio-${priority}`}>優先度: {PRIORITY_LABEL[priority]}</span>;
}

export function DueBadge({ due }: { due: number | null }) {
  if (due == null) return null;
  const days = Math.ceil((due - Date.now()) / 86_400_000);
  const label =
    days < 0 ? `期限超過 ${-days}日` : days === 0 ? "今日締切" : `あと${days}日`;
  const cls = days < 0 ? "due-over" : days <= 2 ? "due-soon" : "";
  return (
    <span className={`badge ${cls}`} title={new Date(due).toLocaleDateString("ja-JP")}>
      {label}
    </span>
  );
}

export function ProjectChip({
  projectId,
  projects,
  sprints,
  sprintId,
}: {
  projectId: string | null;
  projects: Project[];
  sprints?: Sprint[];
  sprintId?: string | null;
}) {
  if (!projectId) return null;
  const p = projects.find((x) => x.id === projectId);
  if (!p) return null;
  const sp = sprintId && sprints ? sprints.find((s) => s.id === sprintId) : null;
  return (
    <span className="badge proj" title="案件 / スプリント">
      {p.name}
      {sp ? ` · ${sp.name}` : ""}
    </span>
  );
}

/**
 * 承認プレビュー/成果物の artifacts・sourceUrl をリンクチップで出す (§3.4 痕跡を可視に)。
 * winnow は外部送出しない=read-only リンク。どちらも空/undefined なら null(現状維持)。
 */
export function ArtifactChips({
  artifacts,
  sourceUrl,
}: {
  artifacts?: string | null;
  sourceUrl?: string | null;
}) {
  let parsed: string[] = [];
  if (artifacts) {
    try {
      const v = JSON.parse(artifacts);
      if (Array.isArray(v)) parsed = v.map((x) => String(x));
    } catch {
      parsed = [artifacts];
    }
  }
  if (parsed.length === 0 && !sourceUrl) return null;
  const isUrl = (s: string) => /^https?:\/\//i.test(s);
  const basename = (s: string) => s.split(/[/\\]/).pop() || s;
  return (
    <div className="badges" style={{ marginTop: 6 }}>
      {sourceUrl && (
        <a className="badge proj" href={sourceUrl} target="_blank" rel="noreferrer">
          🔗 ソース
        </a>
      )}
      {parsed.map((a, i) =>
        isUrl(a) ? (
          <a key={i} className="badge" href={a} target="_blank" rel="noreferrer" title={a}>
            📎 {basename(a)}
          </a>
        ) : (
          <span key={i} className="badge" title={a}>
            📎 {basename(a)}
          </span>
        ),
      )}
    </div>
  );
}

/**
 * 色●だけのコンパクト表示でも色以外の手がかり(sr-only ラベル)を必ず添える (a11y §4-2)。
 */
export function DispositionDot({ disposition }: { disposition: Disposition | null }) {
  if (!disposition) return null;
  return (
    <span className={`badge disp-${disposition}`} title={DISPOSITION_LABEL[disposition]}>
      <span aria-hidden="true">●</span>
      <span className="sr-only">{DISPOSITION_LABEL[disposition]}</span>
    </span>
  );
}

/**
 * 「雑に貼る」入口の暫定タイトル生成。本文先頭の非空行を trim して 60 字に切る。
 * サーバ側 src/server/text.ts と同一ロジック(ドリフトさせない)。
 */
export function provisionalTitle(text: string): string {
  const line = (text ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return (line ?? "").slice(0, 60);
}

/**
 * クリップボードコピー。navigator.clipboard はセキュアコンテキスト(https/localhost)限定のため、
 * 非対応環境では隠し textarea + execCommand にフォールバックし、成否を必ず返す。
 * 呼び出し側は false のとき「コピーしました」を出さないこと(偽の成功通知を出さない)。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 権限拒否等 → フォールバックへ。
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 期日入力(date)をepoch msに。空なら null。 */
export function parseDate(v: string): number | null {
  if (!v) return null;
  const t = new Date(v + "T00:00:00").getTime();
  return isNaN(t) ? null : t;
}
export function toDateInput(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
