import { randomUUID } from "node:crypto";
import { ensureDriver } from "./ai/index.js";
import { decomposePrompt } from "./ai/prompts.js";
import { classify } from "./classifier.js";
import { buildContextBlock } from "./context.js";
import type { ExecutionJob, Item, Rung } from "./domain.js";
import { RUNGS } from "./domain.js";
import { items, jobs, settings } from "./repo.js";

// 分解器 (REQUIREMENTS §3.3-1). ノードに効く。子(ノード/リーフ)を提案し、
// 割り方の選択肢も出す。原則: サイクル長は不確実性に反比例 (§2.3)。

export interface DecomposeOptionChild {
  title: string;
  kind: "node" | "leaf";
  rung: Rung;
  spec: string; // スコープ・前提・受け入れ基準。子の body になる (詳細を下段へ積む §2.2)。
  // polyrepo: この子が親と別リポジトリで作業する場合だけ、その作業ディレクトリ(絶対パス)。
  // 省略時は親の projectDir を継承 (monorepo/同一repoは省略=継承が正)。
  projectDir?: string;
}
export interface DecomposeOption {
  label: string;
  rationale: string;
  process: "waterfall" | "iterative";
  children: DecomposeOptionChild[];
}

/**
 * 割り方の選択肢を AI に出させる(まだ木は作らない)。人間が選ぶ。
 *
 * execute と同じく背景ジョブとして走らせる前提 (routes が background() で叩く)。進行は
 * item.decomposeStatus に永続化し、UI は /api/state ポーリングで映す。これでオーバーレイを
 * 閉じても候補を捨てず、再オープン時は decomposeOptions から AI を呼び直さず即表示できる。
 * 戻り値は後方互換のため候補配列だが、結果の真実源は item 側に書く。
 */
// 分解の二重ディスパッチ防止 (in-flight ガード)。decomposeStatus="running" の永続化が landed
// する前に同一 item の propose が並走しても、ここで弾いて control セッション/AI 呼び出しの
// 重複を防ぐ (execute 側の igniting Set と同型)。finally で必ず外す。
const proposing = new Set<string>();

export async function propose(itemId: string): Promise<DecomposeOption[]> {
  const item = items.get(itemId);
  if (!item) return [];
  // 既に分解中なら再入を弾く (status だけだと書き込み前に並走呼び出しがすり抜ける)。
  if (proposing.has(itemId)) return [];
  proposing.add(itemId);
  let job: ExecutionJob | null = null;
  try {
    // 着手を即座に可視化(running)。古い候補は破棄して running 中の取り違えを防ぐ。
    items.update(itemId, { decomposeStatus: "running", decomposeOptions: null });
    const driver = await ensureDriver();
    job = jobs.create({
      itemId,
      role: "control",
      kindOfWork: "decompose",
      sessionName: null,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      output: null,
      error: null,
      ipcId: null,
    });

    const res = await driver.dispatch({
      id: randomUUID(),
      role: "control",
      label: `分解: ${item.title.slice(0, 30)}`,
      prompt: decomposePrompt(item, buildContextBlock(item)),
      expectJson: true,
      timeoutMs: settings.get().decomposeTimeoutMs || 120_000,
    });

    jobs.update(job.id, {
      sessionName: res.sessionName,
      status: res.ok ? "succeeded" : "failed",
      finishedAt: Date.now(),
      output: res.raw,
      error: res.error ?? null,
    });

    if (!res.ok) {
      // 環境不全(dispatch失敗/JSON解析失敗/タイムアウト)。失敗を永続化し UI が再試行を出せるように。
      items.update(itemId, { decomposeStatus: "failed", decomposeOptions: null });
      return [];
    }
    const data = res.data as { options?: DecomposeOption[] };
    const options: DecomposeOption[] = (data.options ?? []).map((o) => ({
      label: o.label ?? "(無題)",
      rationale: o.rationale ?? "",
      process: o.process === "waterfall" ? "waterfall" : "iterative",
      children: (o.children ?? []).map((c) => ({
        title: c.title ?? "(無題)",
        kind: c.kind === "leaf" ? "leaf" : "node",
        rung: RUNGS.includes(c.rung) ? c.rung : "means",
        spec: typeof c.spec === "string" ? c.spec : "",
        // 別repo明示のみ拾う。空文字/非文字列は継承扱い(undefined)に落とす。
        projectDir:
          typeof c.projectDir === "string" && c.projectDir.trim() ? c.projectDir.trim() : undefined,
      })),
    }));
    // 候補を item にキャッシュ(ready)。オーバーレイ再オープンで AI を呼び直さず即表示する。
    items.update(itemId, { decomposeStatus: "ready", decomposeOptions: JSON.stringify(options) });
    return options;
  } catch (e) {
    // ensureDriver()/dispatch() が throw すると、execute と違い decompose には reconcile/sweep が
    // 無いため running に永久滞留する (UI もスピナーのまま再試行不可)。失敗を永続化して再試行可能に。
    items.update(itemId, { decomposeStatus: "failed", decomposeOptions: null });
    if (job) {
      jobs.update(job.id, {
        status: "failed",
        finishedAt: Date.now(),
        error: (e as Error).message,
      });
    }
    return [];
  } finally {
    proposing.delete(itemId);
  }
}

/**
 * 起動時 reconcile (index.ts が listen 前に一度だけ呼ぶ)。前回プロセスで decomposeStatus="running"
 * のまま中断した item を failed に倒す。decompose は execute と違い done sentinel を残さず、
 * 走っていた control セッションはプロセス終了で消えるため late 回収は不可能=即 failed が正。
 * これをしないと再起動後も running のまま固まり、UI が再試行を出せない。
 */
export function recoverStuckDecomposes(): number {
  let reset = 0;
  for (const it of items.all()) {
    if (it.decomposeStatus === "running") {
      items.update(it.id, { decomposeStatus: "failed", decomposeOptions: null });
      reset++;
    }
  }
  return reset;
}

/**
 * 選んだ割り方を木に反映: 子アイテムを作成し、それぞれを分類にかける。
 * 「割る→各子に実行可能?を付け直す、で一巡」(§3.3). 分類器が昇格判定も兼ねて kind を付ける。
 */
export async function applyOption(
  parentId: string,
  option: DecomposeOption,
): Promise<Item[]> {
  const parent = items.get(parentId);
  if (!parent) return [];
  const created: Item[] = [];
  for (const child of option.children) {
    const item = items.create({
      title: child.title,
      body: child.spec ?? "", // 子に詳細(spec=受け入れ基準)を持たせる。リーフ実行時に効く。
      kind: child.kind,
      rung: child.rung,
      parentId,
      process: option.process,
      domain: parent.domain,
      // polyrepo: 子が別repoを明示したらそれを、無ければ親を継承 (後方互換)。
      projectDir: child.projectDir ?? parent.projectDir,
      projectId: parent.projectId, // 案件もサブツリーに継承する
    });
    created.push(item);
  }
  // 割り方を採用したら親の分解キャッシュは用済み。none に戻し、古い候補が UI に残らないように。
  // 不変条件: 子を持つ親は node。leaf を割った場合(send_back 後など)に親が leaf のまま残ると
  // 親が二重に実行可能扱いされる(executor の kind!=='leaf' 門番をすり抜ける)ため node に昇格させる。
  items.update(parentId, { kind: "node", decomposeStatus: "none", decomposeOptions: null });
  // 各子を分類(=三値仕分け+kind付け直し)。直列でセッションを溶かさない。
  for (const c of created) {
    const updated = await classify(c.id);
    if (updated) Object.assign(c, updated);
  }
  return created;
}
