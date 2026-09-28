/**
 * Fork: turns a terminal's retained output into the plain text an agent reads.
 * The history keeps colors, cursor moves and carriage returns so the drawer can
 * replay it; an agent only needs what a person would see.
 */

// CSI (ESC [ … final), OSC (ESC ] … BEL or ST), DCS/SOS/PM/APC (ESC P|X|^|_ … ST),
// then any other two-byte escape, and finally the 8-bit CSI form.
const ESCAPE_SEQUENCE =
  // oxlint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[ -/]*[0-~]?|\u009b[0-?]*[ -/]*[@-~]/g;
// Control characters other than tab and newline that survive escape stripping.
// oxlint-disable-next-line no-control-regex
const STRAY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** What a line shows after carriage returns overwrite it, as a progress bar redraws itself. */
function resolveCarriageReturns(line: string): string {
  if (!line.includes("\r")) return line;
  let visible = "";
  for (const segment of line.split("\r")) {
    visible = segment + visible.slice(segment.length);
  }
  return visible;
}

/** Applies backspaces, so `ab\bc` reads as `ac`. */
function resolveBackspaces(line: string): string {
  if (!line.includes("\b")) return line;
  const out: Array<string> = [];
  for (const char of line) {
    if (char === "\b") out.pop();
    else out.push(char);
  }
  return out.join("");
}

/** Removes escape sequences and control characters and resolves in-line overwrites. */
export function terminalOutputToPlainText(raw: string): string {
  return raw
    .replace(ESCAPE_SEQUENCE, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      resolveBackspaces(resolveCarriageReturns(line))
        .replace(STRAY_CONTROL, "")
        .replace(/[ \t]+$/, ""),
    )
    .join("\n");
}

export interface TerminalTail {
  readonly text: string;
  /** Lines of the retained output that the tail left out. */
  readonly omittedLines: number;
  /** True when the kept lines were cut further to stay within `maxChars`. */
  readonly truncated: boolean;
}

/**
 * The last `lines` lines of the cleaned output, cut to at most `maxChars` from
 * the end. Trailing blank lines (an idle prompt's redraw, a cleared screen) do
 * not count against the limit.
 */
export function terminalTail(raw: string, lines: number, maxChars: number): TerminalTail {
  const all = terminalOutputToPlainText(raw).replace(/\n+$/, "").split("\n");
  if (all.length === 1 && all[0] === "") return { text: "", omittedLines: 0, truncated: false };
  const kept = all.slice(-lines).join("\n");
  return {
    text: kept.length > maxChars ? kept.slice(-maxChars) : kept,
    omittedLines: Math.max(0, all.length - lines),
    truncated: kept.length > maxChars,
  };
}
