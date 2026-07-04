import { createContext, useContext } from "react";

// 操作結果用の単一 aria-live status を子へ流す軽量 context (§4-1 さばきの結果を読み上げる)。
export const LiveContext = createContext<(msg: string) => void>(() => {});
export function useLive() {
  return useContext(LiveContext);
}
