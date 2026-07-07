import * as SelectPrimitive from "@radix-ui/react-select";
import type { CSSProperties } from "react";

// ネイティブ <select> の代替 (docs/DECISIONS.md「ネイティブダイアログの廃止と select の自前化」)。
// a11y (キーボード操作・typeahead・SR) は Radix UI Select (headless) に委ね、呼び出し側は
// このラッパーだけを知る — ライブラリの差し替え/撤去の変更面をこの1ファイルに限定する。

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// Radix は value="" の Item を許さない (空文字=未選択の内部表現)。ネイティブ select の
// 「"" が実値」(未割当/すべて 等) を保つため、境界で番兵に写像して往復させる。
const EMPTY = "\u0000empty";
const toRadix = (v: string): string => (v === "" ? EMPTY : v);
const fromRadix = (v: string): string => (v === EMPTY ? "" : v);

export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  title,
  disabled,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  return (
    <SelectPrimitive.Root
      value={toRadix(value)}
      onValueChange={(v) => onChange(fromRadix(v))}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        className="sel-trigger"
        aria-label={ariaLabel}
        title={title}
        style={style}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon className="sel-icon" aria-hidden>
          ▾
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        {/* popper 配置: トリガー直下にドロップダウンとして出す (ネイティブの見た目に近く、
            密な行レイアウト内でも予測可能な位置に開く)。 */}
        <SelectPrimitive.Content className="sel-content" position="popper" sideOffset={4}>
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={toRadix(o.value)}
                disabled={o.disabled}
                className="sel-item"
              >
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="sel-check" aria-hidden>
                  ✓
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
