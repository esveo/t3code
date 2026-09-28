import remarkMath from "remark-math";

/** Tag names the fork's chat renderer maps to the math and diagram components. */
export const RICH_MARKDOWN_MATH_TAG = "t3-math";
export const RICH_MARKDOWN_MERMAID_TAG = "t3-mermaid";

type RichMarkdownNode = {
  type: string;
  value?: string;
  lang?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: Record<string, unknown>;
  children?: RichMarkdownNode[];
};

/**
 * Whether a fenced code block's source ends with its closing fence. While a
 * response streams, an open fence runs to the end of the text and its content
 * is still growing.
 */
export function isFenceClosed(source: string): boolean {
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(source)?.[1];
  if (!opening) return false;
  const lastLine = source.slice(source.lastIndexOf("\n") + 1);
  // Inside lists and block quotes the closing line carries their indentation and markers.
  return new RegExp(`^[ \\t>]*${opening[0]}{${opening.length},}[ \\t]*$`).test(lastLine);
}

/**
 * Whether `$…$` reads as prose rather than math, as in "$5 and $10" or "$5-$10".
 * Follows Pandoc: the content may not start or end with whitespace, and the
 * closing dollar may not be followed by a digit.
 */
export function isDollarAmountNotMath(source: string, value: string, nextChar: string): boolean {
  if (source.startsWith("$$")) return false;
  return /^\s|\s$/.test(value) || /\d/.test(nextChar);
}

function sourceOf(node: RichMarkdownNode, text: string): string | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : text.slice(start, end);
}

function transformRichMarkdown(tree: RichMarkdownNode, file: { value?: unknown }) {
  const text = String(file.value ?? "");
  const visit = (parent: RichMarkdownNode) => {
    const children = parent.children;
    if (!children) return;
    children.forEach((node, index) => {
      if (node.type === "inlineMath") {
        const source = sourceOf(node, text);
        const end = node.position?.end.offset;
        if (
          source !== undefined &&
          end !== undefined &&
          isDollarAmountNotMath(source, node.value ?? "", text.charAt(end))
        ) {
          children[index] = { type: "text", value: source };
          return;
        }
        node.data = {
          hName: RICH_MARKDOWN_MATH_TAG,
          hChildren: [{ type: "text", value: node.value ?? "" }],
        };
        return;
      }
      if (node.type === "math") {
        node.data = {
          hName: RICH_MARKDOWN_MATH_TAG,
          hProperties: { dataDisplay: "" },
          hChildren: [{ type: "text", value: node.value ?? "" }],
        };
        return;
      }
      if (node.type === "code" && node.lang?.toLowerCase() === "mermaid") {
        const source = sourceOf(node, text);
        // An open fence stays a code block until the diagram is complete.
        if (source === undefined || !isFenceClosed(source)) return;
        children[index] = {
          type: "mermaidDiagram",
          data: { hName: RICH_MARKDOWN_MERMAID_TAG },
          children: [node],
        };
        return;
      }
      visit(node);
    });
  };
  visit(tree);
}

function remarkRichMarkdownNodes() {
  return transformRichMarkdown;
}

/** Fork: math (`$…$`, `$$…$$`) and closed ```mermaid fences for the chat renderer. */
export const RICH_MARKDOWN_REMARK_PLUGINS = [remarkMath, remarkRichMarkdownNodes] as const;

/** Lets the fork's elements through the chat renderer's sanitizer. */
export function withRichMarkdownSanitizeSchema<
  Schema extends {
    tagNames?: string[] | null | undefined;
    attributes?: Record<string, unknown[]> | null | undefined;
  },
>(schema: Schema): Schema {
  return {
    ...schema,
    tagNames: [...(schema.tagNames ?? []), RICH_MARKDOWN_MATH_TAG, RICH_MARKDOWN_MERMAID_TAG],
    attributes: { ...schema.attributes, [RICH_MARKDOWN_MATH_TAG]: ["dataDisplay"] },
  };
}
