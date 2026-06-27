// 収録した webm を README 用のアニメーション WebP に変換する。
// WebP を主成果物にする理由: GIF より高画質・小容量で、日本語の細字や罫線がにじみにくい。
// 必要ツール: ffmpeg(libwebp_anim 付き)。docs/assets/*.webp だけをコミットする。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FPS = 14;
const WIDTH = 1080; // README 表示幅。2x 収録から縮小して文字をくっきりさせる。
const QUALITY = 70;

export function convertAll(recDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const webms = fs
    .readdirSync(recDir)
    .filter((f) => f.endsWith(".webm"))
    .sort();
  if (webms.length === 0) {
    console.warn("convert: no .webm in", recDir);
    return [];
  }
  const out = [];
  for (const f of webms) {
    const inPath = path.join(recDir, f);
    const outPath = path.join(outDir, f.replace(/\.webm$/, ".webp"));
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-i", inPath,
        "-vf", `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`,
        "-c:v", "libwebp_anim",
        "-loop", "0",
        "-lossless", "0",
        "-q:v", String(QUALITY),
        "-compression_level", "6",
        "-an",
        outPath,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const kb = Math.round(fs.statSync(outPath).size / 1024);
    console.log(`    ✓ ${path.basename(outPath)} (${kb} KB)`);
    out.push({ outPath, kb });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const recDir = process.argv[2] || path.join(process.cwd(), "demo", ".rec");
  const outDir = process.argv[3] || path.join(process.cwd(), "docs", "assets");
  convertAll(recDir, outDir);
}
