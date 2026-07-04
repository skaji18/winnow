# CLAUDE.md

AI実行つきタスク管理ツール。背骨は `REQUIREMENTS.md`（§番号で引用される）。用語は `docs/GLOSSARY.md`。

## ビルドゲート（ランナーは node 組み込みのみ・追加依存なし）

- typecheck: `npx tsc --noEmit`（ルート1枚の tsconfig が src/ と web/src/ と colocate した `*.test.ts` を検査）
- test: `npm test`（node:test + 既存 tsx。DB に触るテストは `src/server/testing/tmp-home.ts` を先頭 import）
- build: `npx vite build`
- smoke: `WINNOW_HOME=$(mktemp -d) npx tsx scripts-smoke-feedback.ts`

まとめて: `npm run gate`（typecheck → test → build → smoke）。

## ドキュメント運用ルール（重要・ユーザ確認済み）

**リデザイン/バッチごとに新しい設計ファイル（`*_REDESIGN.md` 等）を作らない。** 行き先は3つ:

1. **決定と根拠・却下した代替・defer** → `docs/DECISIONS.md` に1節追記
   （追記型の履歴。様式: 問い → 中核 → 決定/却下/defer。既存節に倣う）。
2. **実装が守るべき不変条件** → `docs/INVARIANTS.md` を現在形で更新
   （生きたドキュメント。破る/緩める変更は先に DECISIONS に決定を残す）。
3. **実装順序・監査の生データ・一過性の計画** → コミットメッセージ/PR 本文へ
   （リポジトリに恒久ファイルを作らない）。

## 実装の作法

- 各バッチは独立にビルドが通る粒度でコミット（コミットメッセージに決定の要約を書く）。
- 変更前に `docs/INVARIANTS.md` に目を通し、較正母数の純度・scoreItem の純度・注入の信頼境界・
  DB マイグレーション規約（版繰り上げ+専用 migrate）・処理量メトリクス禁止を守る。
