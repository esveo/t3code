import { lookupOriginalPosition, type RawSourceMap } from "./sourceMapLookup";

// Chromium frames: "    at name (url:line:column)" or "    at url:line:column".
const FRAME_PATTERN = /^(\s*at\s+)(?:(.+?)\s+\()?([a-z][\w+.-]*:\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/i;

export type SourceMapLoader = (scriptUrl: string) => Promise<RawSourceMap | null>;

/** Shortens a source map path to its place in the repo or package. */
export function displaySourcePath(source: string): string {
  const packagePath = source.lastIndexOf("node_modules/");
  if (packagePath !== -1) return source.slice(packagePath + "node_modules/".length);
  return source.replace(/^(?:[a-z][\w+.-]*:\/\/\/?)?(?:\.\.?\/)+/i, "");
}

/**
 * Rewrites every bundle frame in `text` to its original source location. Frames
 * without a reachable source map stay as they were.
 */
export async function symbolicateStackText(
  text: string,
  loadMap: SourceMapLoader,
): Promise<string> {
  const maps = new Map<string, Promise<RawSourceMap | null>>();
  const lines = await Promise.all(
    text.split("\n").map(async (line) => {
      const frame = FRAME_PATTERN.exec(line);
      if (!frame) return line;
      const [, prefix, name, url, generatedLine, generatedColumn] = frame;
      let map = maps.get(url!);
      if (!map) {
        map = loadMap(url!).catch(() => null);
        maps.set(url!, map);
      }
      const resolved = await map;
      const position = resolved
        ? lookupOriginalPosition(resolved, Number(generatedLine), Number(generatedColumn))
        : null;
      if (!position) return line;
      const location = `${displaySourcePath(position.source)}:${position.line}:${position.column}`;
      const originalName = position.name ?? name;
      return originalName ? `${prefix}${originalName} (${location})` : `${prefix}${location}`;
    }),
  );
  return lines.join("\n");
}

/** Loads `<script>.map` next to same-origin bundles, which is where Vite writes them. */
export function sameOriginSourceMapLoader(location: {
  readonly protocol: string;
  readonly host: string;
}): SourceMapLoader {
  return async (scriptUrl) => {
    // Compares protocol and host because URL.origin is "null" for custom schemes such as t3code://.
    const script = new URL(scriptUrl);
    if (script.protocol !== location.protocol || script.host !== location.host) return null;
    const response = await fetch(`${scriptUrl.split(/[?#]/)[0]}.map`);
    if (!response.ok) return null;
    return (await response.json()) as RawSourceMap;
  };
}
