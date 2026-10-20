export interface RawSourceMap {
  readonly sources: ReadonlyArray<string | null>;
  readonly names?: ReadonlyArray<string>;
  readonly mappings: string;
  readonly sourceRoot?: string;
}

export interface OriginalPosition {
  readonly source: string;
  /** 1-based, like the stack frame it came from. */
  readonly line: number;
  /** 1-based, like the stack frame it came from. */
  readonly column: number;
  readonly name: string | null;
}

// [generatedColumn, sourceIndex, originalLine, originalColumn, nameIndex?], all 0-based.
type Segment = readonly [number, number, number, number, number | undefined];

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Map([...BASE64_DIGITS].map((char, index) => [char, index]));

function decodeVlqGroup(group: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of group) {
    const digit = BASE64_VALUES.get(char);
    if (digit === undefined) return [];
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return values;
}

/** Decodes the mappings of one generated line, which carry deltas from every line before it. */
function decodeLines(mappings: string, lastLine: number): Segment[][] {
  const lines: Segment[][] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  const encodedLines = mappings.split(";");
  for (let line = 0; line <= lastLine && line < encodedLines.length; line += 1) {
    const segments: Segment[] = [];
    let generatedColumn = 0;
    for (const group of encodedLines[line]!.split(",")) {
      if (group.length === 0) continue;
      const values = decodeVlqGroup(group);
      if (values.length < 4) {
        generatedColumn += values[0] ?? 0;
        continue;
      }
      generatedColumn += values[0]!;
      sourceIndex += values[1]!;
      originalLine += values[2]!;
      originalColumn += values[3]!;
      let name: number | undefined;
      if (values.length >= 5) {
        nameIndex += values[4]!;
        name = nameIndex;
      }
      segments.push([generatedColumn, sourceIndex, originalLine, originalColumn, name]);
    }
    lines.push(segments);
  }
  return lines;
}

/** Maps a 1-based generated line and column back to the original source. */
export function lookupOriginalPosition(
  map: RawSourceMap,
  line: number,
  column: number,
): OriginalPosition | null {
  const segments = decodeLines(map.mappings, line - 1)[line - 1];
  if (!segments) return null;
  let match: Segment | undefined;
  for (const segment of segments) {
    if (segment[0] > column - 1) break;
    match = segment;
  }
  if (!match) return null;
  const source = map.sources[match[1]];
  if (!source) return null;
  return {
    source: `${map.sourceRoot ?? ""}${source}`,
    line: match[2] + 1,
    column: match[3] + 1,
    name: match[4] === undefined ? null : (map.names?.[match[4]] ?? null),
  };
}
