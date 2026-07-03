import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * AI実行結果(execute プロンプトの output は「markdown可」)の表示用レンダラー。
 * - 出力が markdown である保証はないため remark-breaks で単一改行を保持し、
 *   プレーンテキストでも <pre> と同等の見え方に落ちるようにする。
 * - AI出力は低信頼データ: react-markdown は生HTMLを描画しない(既定でエスケープ)ので
 *   dangerouslySetInnerHTML 系のサニタイズ問題を持ち込まない。
 * - リンクは新規タブ + rel で opener/referrer を切る(read-only 痕跡の閲覧のみ)。
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node: _n, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
