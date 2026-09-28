import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Components, ExtraProps } from "react-markdown";
import { useTheme } from "../../hooks/useTheme";
import { LRUCache } from "../../lib/lruCache";
import { RICH_MARKDOWN_MATH_TAG, RICH_MARKDOWN_MERMAID_TAG } from "./remarkRichMarkdown";

type HastNode = NonNullable<ExtraProps["node"]>;
type RichElementProps = ExtraProps & { children?: ReactNode };

function hastText(node: HastNode | HastNode["children"][number] | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  return "children" in node
    ? node.children.map((child) => hastText(child as HastNode)).join("")
    : "";
}

type Katex = typeof import("katex").default;

// KaTeX and its stylesheet load with the first formula, not with the app.
let loadedKatex: Katex | undefined;
let katexPromise: Promise<Katex> | undefined;
function loadKatex(): Promise<Katex> {
  katexPromise ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
    ([module]) => (loadedKatex = module.default),
  );
  return katexPromise;
}

function RichMarkdownMath({ node }: RichElementProps) {
  const tex = hastText(node);
  const display = node?.properties?.dataDisplay !== undefined;
  const [katex, setKatex] = useState(loadedKatex);
  useEffect(() => {
    if (katex) return;
    let cancelled = false;
    void loadKatex().then(
      (loaded) => !cancelled && setKatex(() => loaded),
      (cause: unknown) => console.error("[rich-markdown] KaTeX failed to load", cause),
    );
    return () => {
      cancelled = true;
    };
  }, [katex]);
  // Invalid or still-streaming TeX shows its source instead of an error.
  const html = useMemo(() => {
    if (!katex) return null;
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: true });
    } catch {
      return null;
    }
  }, [katex, tex, display]);

  if (display) {
    const copy = `$$\n${tex}\n$$\n\n`;
    return html ? (
      <div
        className="chat-markdown-math my-3 overflow-x-auto overflow-y-hidden"
        data-markdown-copy={copy}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    ) : (
      <pre data-markdown-copy={copy}>
        <code>{tex}</code>
      </pre>
    );
  }
  const copy = `$${tex}$`;
  return html ? (
    <span data-markdown-copy={copy} dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <code data-markdown-copy={copy}>{tex}</code>
  );
}

type Theme = ReturnType<typeof useTheme>["resolvedTheme"];

// Rendered diagrams by theme and source; an empty string marks invalid syntax.
// Virtualized message lists remount blocks often, and mermaid renders are slow.
const mermaidSvgCache = new LRUCache<string>(200, 20 * 1024 * 1024);
let mermaidQueue: Promise<unknown> = Promise.resolve();
let mermaidRenderCount = 0;

/** Mermaid keeps global config and a shared render sandbox, so renders run one at a time. */
function renderMermaid(code: string, theme: Theme): Promise<string> {
  const render = mermaidQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
    });
    if (!(await mermaid.parse(code, { suppressErrors: true }))) return "";
    const { svg } = await mermaid.render(`t3-mermaid-${++mermaidRenderCount}`, code);
    return svg;
  });
  mermaidQueue = render.catch(() => undefined);
  return render.catch((cause: unknown) => {
    console.error("[rich-markdown] mermaid render failed", cause);
    return "";
  });
}

/** Renders a closed ```mermaid fence; its children are the regular code block, shown until the diagram is ready or when it is invalid. */
function RichMarkdownMermaid({ node, children }: RichElementProps) {
  const code = hastText(node).trim();
  const { resolvedTheme } = useTheme();
  const key = `${resolvedTheme}\n${code}`;
  const [rendered, setRendered] = useState<string | null>(null);
  const cached = mermaidSvgCache.get(key);
  useEffect(() => {
    if (mermaidSvgCache.get(key) !== null) return;
    let cancelled = false;
    void renderMermaid(code, resolvedTheme).then((svg) => {
      mermaidSvgCache.set(key, svg, svg.length * 2 + 64);
      if (!cancelled) setRendered(svg);
    });
    return () => {
      cancelled = true;
    };
  }, [code, key, resolvedTheme]);

  // While a theme switch re-renders, the previous diagram stays in place.
  const svg = cached ?? rendered;
  if (!svg) return <>{children}</>;
  return (
    <div
      className="chat-markdown-mermaid my-3 flex justify-center overflow-x-auto rounded-lg border border-border/70 p-3"
      data-markdown-copy={`\`\`\`mermaid\n${code}\n\`\`\`\n\n`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Fork: renderers for the elements `remarkRichMarkdown` emits. */
export const RICH_MARKDOWN_COMPONENTS = {
  [RICH_MARKDOWN_MATH_TAG]: RichMarkdownMath,
  [RICH_MARKDOWN_MERMAID_TAG]: RichMarkdownMermaid,
} as Components;
