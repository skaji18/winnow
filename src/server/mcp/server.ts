// MCP サーバ本体: Claude が作業中に見つけたタスク/問いを、離脱せず winnow に放り込む口。
// 設計の規律 (REQUIREMENTS §4/§5): 口はバカ、分類器が賢い。Claude には disposition/
// confidence/rung を選ばせない (それは分類器の仕事で、人間のさばきが教師信号 §2/§4)。
// よって公開ツールは「捕獲」1個だけ。キュー閲覧や判断の書き戻しは出さない
// (=ターミナルに第二のトリアージ面を作らない / §5 で死なせない)。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureItem, captureSchema } from "../capture.js";

// ツールの入力スキーマは「生の zod shape オブジェクト」で渡す (SDK v1 の仕様。
// V2 ドキュメントの z.object(...) 形式とは異なる)。cross-field の必須判定
// (title か body) は shape では表現できないので、ハンドラ内で captureSchema が担保する。
const captureInputShape = {
  title: z
    .string()
    .optional()
    .describe("短いタイトル。省略可。省略時は body 先頭行から自動生成される。"),
  body: z
    .string()
    .optional()
    .describe(
      "★最重要。会話の文脈・経緯・関係ファイルパス・エラー・受け入れ条件を丸ごとここに。" +
        "title は空でよく、body がリッチなほど分類も後段の分解も良くなる(上流の文脈は下流で複利)。",
    ),
  kind: z
    .enum(["node", "leaf"])
    .optional()
    .describe(
      "ヒントのみ(最終判定は分類器)。leaf=具体的に実行可能なタスク / " +
        "node=まだ実行不可の問い・意図・より上位のもの。迷ったら node。",
    ),
  domain: z
    .enum(["software", "general"])
    .optional()
    .describe("ソフト開発タスクなら software。git リポジトリ内で見つけたものは大抵 software。"),
  projectDir: z
    .string()
    .optional()
    .describe("software の作業ディレクトリ。リポジトリ内なら git トップレベル/cwd を渡す。"),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  dueDate: z.number().optional().describe("期日 (epoch ミリ秒)。"),
  parentId: z.string().optional().describe("既存アイテムの子として紐付ける場合の親 ID。"),
  classify: z
    .boolean()
    .optional()
    .describe("既定 true。まとめて大量投入する時など、即時分類を避けたい場合のみ false。"),
};

/**
 * リクエスト毎に新しい McpServer を組む (stateless 運用。transport と 1:1)。
 * ツール登録は安いので使い捨てで問題ない。
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "winnow", version: "0.1.0" });

  server.registerTool(
    "winnow_capture",
    {
      title: "Capture into winnow",
      description:
        "作業中に見つけたタスク・問い・より上位のものを winnow に登録する(=Web UIの『雑に貼る入口』)。" +
        "離脱せずその場で放り込むための口。登録すると winnow の分類器が裏で " +
        "自動/要確認/要判断 に仕分ける——その判断は呼び出し側ではなく winnow の仕事なので、" +
        "ここでは仕分けや実行はせず、文脈ごと素早く渡すことに徹する。" +
        "判断が要るものは利用者の Web キューに出る。" +
        "『より上位のもの』(問い・テーマ・案件級)は kind:'node' で渡せば、分類器が高度を付ける。",
      inputSchema: captureInputShape,
    },
    async (args) => {
      try {
        // shape 検証済みの args を、cross-field refine 込みで再検証してから捕獲。
        const item = captureItem(captureSchema.parse(args));
        const summary =
          `登録しました (id: ${item.id}, kind: ${item.kind})。` +
          (args.classify === false
            ? "分類はスキップしました。"
            : "分類器が裏で仕分けます。判断が要るものは winnow の Web キューに出ます。");
        return {
          content: [
            {
              type: "text" as const,
              text: `${summary}\ntitle: ${item.title}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `登録に失敗しました: ${msg}` }],
        };
      }
    },
  );

  return server;
}
