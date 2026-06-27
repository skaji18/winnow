# デモGIFの作り方・撮り直し方

README の「使用感（デモ）」に貼っている WebP は、**手作業ではなく再生成可能なビルド成果物**です。
機能改修で画面が変わったら、このディレクトリの仕組みで撮り直します。

## ワンコマンド再生成

```sh
npm run demo
```

これで次を自動で行います:

1. 使い捨ての DB(`demo/.home/`)を作り直し、デモ用の状態を投入(`scripts-seed-demo.ts`)
2. 本番ビルド(`web/dist`)
3. **フェイクAI**(`WINNOW_FAKE_AI=1`)でサーバを起動 — 本物の `claude`/tmux/ログイン不要
4. Playwright で各フローを操作し動画(webm)を収録(`demo/record.mjs`)
5. ffmpeg で WebP に変換し `docs/assets/*.webp` を更新(`demo/convert.mjs`)

特定のフローだけ撮り直す:

```sh
npm run demo -- 05-terminal-theater
```

## 必要なもの

- Node.js / Playwright(`playwright` は devDependency。ブラウザは環境のものを `executablePath` で使う)
- **ffmpeg**(libwebp 付き。webm → WebP 変換に使用)。例: `apt-get install -y ffmpeg`

## どの GIF が何で出来ているか（撮り直しの早見表）

| 成果物 (`docs/assets/`) | 撮影フロー (`demo/record.mjs`) | 見せている概念 | 主に参照する画面 |
|---|---|---|---|
| `01-capture-to-queue.webp` | `flowCaptureToQueue` | 登録→自動仕分け→要確認で着地 | 上部の登録欄 + キュー |
| `02-escalation-queue.webp` | `flowEscalationQueue` | 自動分は畳む・要確認だけの短いキュー | キュー一覧 |
| `03-disposition-and-undo.webp` | `flowDispositionAndUndo` | 処分＝教師信号・取り消し | キューカードの「分類し直す」「さばきを戻す」 |
| `04-approve-and-run.webp` | `flowApproveAndRun` | 不可逆はワンタップ承認→実行 | 承認待ちカード |
| `05-terminal-theater.webp` | `flowTerminalTheater` | AIが動く端末をライブ閲覧 | セッションタブ + 端末ペイン |

## 仕組みと保守のポイント

- **決定性**: 固定シード(`scripts-seed-demo.ts`)＋フェイクAI(`src/server/ai/fake-driver.ts`)＋固定ビューポートで、毎回ほぼ同じ画が撮れる。
- **モックは本番から疎結合**: フェイクAIは `AiDriver` インターフェース(`src/server/ai/driver.ts`)だけに依存し、`WINNOW_FAKE_AI=1` のときだけ選ばれる(本番経路からは到達しない)。本番ロジックには触れていないので、機能改修の大半では壊れない。
- **セレクタ**: 操作は製品の安定した日本語ラベル/role を基準にしている。文言を変えたら `demo/record.mjs` の該当フローだけ直す。
- **端末劇場(05)** は GUI 改修の影響を受けない(台本は `fake-driver.ts` 内)。GUI を変えたときは原則 01〜04 を撮り直せば足りる。
- **コミットするのは `docs/assets/*.webp` だけ**。中間物(`demo/.home/`・`demo/.rec/`)は `.gitignore` 済み。
