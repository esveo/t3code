import { describe, expect, it } from "@effect/vitest";

import { terminalOutputToPlainText, terminalTail } from "./terminalText.ts";

describe("terminalOutputToPlainText", () => {
  it("removes colors, cursor movement and window titles", () => {
    const raw =
      "\u001b]0;user@host: ~/project\u0007\u001b[1;32m✓\u001b[0m built in \u001b[33m1.2s\u001b[39m\u001b[K\r\n" +
      "\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\ done\u001b[?25h\n";
    expect(terminalOutputToPlainText(raw)).toBe("✓ built in 1.2s\nlink done\n");
  });

  it("keeps what a progress bar shows last after carriage returns", () => {
    const redraws = `Downloading 10%\rDownloading 55%\r${"Done".padEnd(15)}\n`;
    expect(terminalOutputToPlainText(redraws)).toBe("Done\n");
    expect(terminalOutputToPlainText("abcdef\rXY\n")).toBe("XYcdef\n");
  });

  it("applies backspaces and drops stray control characters", () => {
    expect(terminalOutputToPlainText("ab\bc\u0007\u0000d\tx")).toBe("acd\tx");
  });
});

describe("terminalTail", () => {
  const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\r\n");

  it("returns the last lines and counts what it left out", () => {
    expect(terminalTail(`${output}\r\n$ `, 3, 1_000)).toEqual({
      text: "line 9\nline 10\n$",
      omittedLines: 8,
      truncated: false,
    });
  });

  it("ignores trailing blank lines", () => {
    expect(terminalTail(`${output}\n\n\n`, 2, 1_000).text).toBe("line 9\nline 10");
  });

  it("cuts to the character limit from the end", () => {
    expect(terminalTail(output, 10, 7)).toEqual({
      text: "line 10",
      omittedLines: 0,
      truncated: true,
    });
  });

  it("reads empty output as empty", () => {
    expect(terminalTail("\u001b[2J\u001b[H", 200, 1_000)).toEqual({
      text: "",
      omittedLines: 0,
      truncated: false,
    });
  });
});
