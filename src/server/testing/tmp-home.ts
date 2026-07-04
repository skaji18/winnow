// テスト専用の副作用モジュール: WINNOW_HOME を使い捨ての一時ディレクトリへ向ける。
//
// 規約: repo/db/queue/calibration 等、DB に触るテストファイルでは本モジュールの import を
// 【import 文の先頭】に置くこと。db.ts は import された瞬間に WINNOW_HOME 配下の SQLite へ
// 接続する(config.ts が module 評価時に process.env.WINNOW_HOME を読む)ため、ESM の評価順で
// 本モジュールを db.ts より先に評価させる必要がある。
//
//   import "../testing/tmp-home.js"; // ← 必ず先頭
//   import { db } from "../db.js";
//
// WINNOW_HOME が外から設定されていても常に上書きする — テストが実運用の ~/.winnow や
// 作業用 DB を誤って触らないための安全弁。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.WINNOW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "winnow-test-"));

/** このテストプロセスが使う使い捨て WINNOW_HOME (デバッグ・後始末用)。 */
export const TEST_WINNOW_HOME: string = process.env.WINNOW_HOME;
