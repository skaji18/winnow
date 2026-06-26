// 非永続(プロセス内メモリ)の起動時 runtime state。Settings(永続JSON)とは分離する。
// preflight 結果と reconcile 痕跡は起動毎に再算出する一時状態で DB に持つべきでなく
// (背骨§1.3 の system-of-record は永続バックログ/優先順位/依存/ステータスを指す)、
// Settings の JSON blob に混ぜると update でユーザ設定と競合する。
//
// in-flight 集計(実行中N/承認待ちM)は DB 由来の決定論値なのでここには持たず、
// executor.inFlightCount() で都度算出する(状態の二重持ちを避ける)。runtime-state は
// preflight/reconcile の痕跡のみに限定する。

export interface RuntimeState {
  preflight: {
    tmuxOk: boolean;
    claudeOk: boolean;
    checkedAt: number | null;
    note: string | null;
  };
  reconcile: {
    ranAt: number | null;
    recovered: number;
    failedOver: number;
  };
}

// 初期値: preflight 未実施(checkedAt:null)。tmuxOk/claudeOk は楽観既定 true=
// UI(Batch6)はフラグが false に倒れた時だけ警告を出す。
let state: RuntimeState = {
  preflight: { tmuxOk: true, claudeOk: true, checkedAt: null, note: null },
  reconcile: { ranAt: null, recovered: 0, failedOver: 0 },
};

export function getRuntimeState(): RuntimeState {
  return state;
}

export function setPreflight(p: RuntimeState["preflight"]): void {
  state = { ...state, preflight: p };
}

export function setReconcile(r: RuntimeState["reconcile"]): void {
  state = { ...state, reconcile: r };
}
