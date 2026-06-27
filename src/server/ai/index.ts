import { settings } from "../repo.js";
import type { AiDriver } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { HeadlessDriver } from "./headless-driver.js";
import { TmuxDriver } from "./tmux-driver.js";

let driver: AiDriver | null = null;
let initPromise: Promise<void> | null = null;

export function getDriver(): AiDriver {
  if (driver) return driver;
  // デモ/録画モード: 本物の claude/tmux を使わず台本どおりに動く(README GIF を決定的に撮るため)。
  // 本番起動経路からは到達しない(WINNOW_FAKE_AI を立てたときだけ)。
  if (process.env.WINNOW_FAKE_AI === "1") driver = new FakeDriver();
  else driver = settings.get().useHeadless ? new HeadlessDriver() : new TmuxDriver();
  return driver;
}

/** Lazily initialize the driver on first AI use, not at server boot. */
export async function ensureDriver(): Promise<AiDriver> {
  const d = getDriver();
  if (!initPromise) initPromise = d.init();
  await initPromise;
  return d;
}

/** Force re-selection (e.g. after toggling useHeadless in settings). */
export function resetDriver(): void {
  driver = null;
  initPromise = null;
}

export type { AiDriver } from "./driver.js";
