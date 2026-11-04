/**
 * Fork: Notion's named colors as Tailwind classes, light and dark. Class
 * strings stay literal so Tailwind sees them.
 */
const TEXT: Record<string, string> = {
  gray: "text-[#787774] dark:text-[#9b9b9b]",
  brown: "text-[#9f6b53] dark:text-[#ba856f]",
  orange: "text-[#d9730d] dark:text-[#c77d48]",
  yellow: "text-[#cb912f] dark:text-[#ca9849]",
  green: "text-[#448361] dark:text-[#529e72]",
  blue: "text-[#337ea9] dark:text-[#379ad3]",
  purple: "text-[#9065b0] dark:text-[#9d68d3]",
  pink: "text-[#c14c8a] dark:text-[#d15796]",
  red: "text-[#d44c47] dark:text-[#df5452]",
};

const BACKGROUND: Record<string, string> = {
  gray: "bg-[#f1f1ef] dark:bg-[#2f2f2f]",
  brown: "bg-[#f4eeee] dark:bg-[#4a3228]",
  orange: "bg-[#fbecdd] dark:bg-[#5c3b23]",
  yellow: "bg-[#fbf3db] dark:bg-[#56452f]",
  green: "bg-[#edf3ec] dark:bg-[#243d30]",
  blue: "bg-[#e7f3f8] dark:bg-[#143a4e]",
  purple: "bg-[#f8f3fc] dark:bg-[#3c2d49]",
  pink: "bg-[#fcf1f6] dark:bg-[#4e2c3c]",
  red: "bg-[#fdebec] dark:bg-[#522e2a]",
};

const OPTION: Record<string, string> = {
  default: "bg-[#e3e2e080] text-[#32302c] dark:bg-[#373737] dark:text-white/80",
  gray: "bg-[#e3e2e0] text-[#32302c] dark:bg-[#5a5a5a] dark:text-white/80",
  brown: "bg-[#eee0da] text-[#442a1e] dark:bg-[#603b2c] dark:text-white/80",
  orange: "bg-[#fadec9] text-[#49290e] dark:bg-[#854c1d] dark:text-white/80",
  yellow: "bg-[#fdecc8] text-[#402c1b] dark:bg-[#89632a] dark:text-white/80",
  green: "bg-[#dbeddb] text-[#1c3829] dark:bg-[#2b593f] dark:text-white/80",
  blue: "bg-[#d3e5ef] text-[#183347] dark:bg-[#28456c] dark:text-white/80",
  purple: "bg-[#e8deee] text-[#412454] dark:bg-[#492f64] dark:text-white/80",
  pink: "bg-[#f5e0e9] text-[#4c2337] dark:bg-[#69314c] dark:text-white/80",
  red: "bg-[#ffe2dd] text-[#5d1715] dark:bg-[#6e3630] dark:text-white/80",
};

const STATUS_DOT: Record<string, string> = {
  default: "bg-[#91918e]",
  gray: "bg-[#91918e]",
  brown: "bg-[#a27763]",
  orange: "bg-[#cc782f]",
  yellow: "bg-[#c29343]",
  green: "bg-[#548164]",
  blue: "bg-[#5e87c9]",
  purple: "bg-[#9a6dd7]",
  pink: "bg-[#b35488]",
  red: "bg-[#c4554d]",
};

/** A rich-text or block color such as `red` or `red_background`. */
export function notionColorClass(color: string | undefined): string {
  if (color === undefined) return "";
  if (color.endsWith("_background")) return BACKGROUND[color.slice(0, -11)] ?? "";
  return TEXT[color] ?? "";
}

export const optionColorClass = (color: string) => OPTION[color] ?? OPTION.default!;
export const statusDotClass = (color: string) => STATUS_DOT[color] ?? STATUS_DOT.default!;
