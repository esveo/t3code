import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import {
  isDollarAmountNotMath,
  isFenceClosed,
  RICH_MARKDOWN_REMARK_PLUGINS,
  withRichMarkdownSanitizeSchema,
} from "./remarkRichMarkdown";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, ...RICH_MARKDOWN_REMARK_PLUGINS]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, withRichMarkdownSanitizeSchema(defaultSchema)]]}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("isFenceClosed", () => {
  it("needs a closing fence at least as long as the opening one", () => {
    expect(isFenceClosed("```mermaid\ngraph TD\n```")).toBe(true);
    expect(isFenceClosed("````mermaid\ngraph TD\n```")).toBe(false);
    expect(isFenceClosed("~~~mermaid\ngraph TD\n~~~~")).toBe(true);
  });

  it("treats a fence still streaming as open", () => {
    expect(isFenceClosed("```mermaid\ngraph TD\n  A --> B")).toBe(false);
    expect(isFenceClosed("```mermaid\ngraph TD\n``")).toBe(false);
  });

  it("accepts closing fences indented inside lists and quotes", () => {
    expect(isFenceClosed("```mermaid\n  graph TD\n  ```")).toBe(true);
    expect(isFenceClosed("```mermaid\n> graph TD\n> ```")).toBe(true);
  });
});

describe("isDollarAmountNotMath", () => {
  it("keeps prices as text", () => {
    expect(isDollarAmountNotMath("$5 and $", "5 and ", "1")).toBe(true);
    expect(isDollarAmountNotMath("$5-$", "5-", "1")).toBe(true);
  });

  it("accepts formulas", () => {
    expect(isDollarAmountNotMath("$x^2$", "x^2", " ")).toBe(false);
    expect(isDollarAmountNotMath("$$ x $$", " x ", "")).toBe(false);
  });
});

describe("RICH_MARKDOWN_REMARK_PLUGINS", () => {
  it("emits inline and display math through the sanitizer", () => {
    const html = renderMarkdown("Euler: $e^{i\\pi} = -1$\n\n$$\n\\int_0^1 x\\,dx\n$$");

    expect(html).toContain("<t3-math>e^{i\\pi} = -1</t3-math>");
    expect(html).toContain('<t3-math data-display="">\\int_0^1 x\\,dx</t3-math>');
  });

  it("leaves dollar amounts alone", () => {
    const html = renderMarkdown("It costs $5 and $10 per seat.");

    expect(html).not.toContain("t3-math");
    expect(html).toContain("It costs $5 and $10 per seat.");
  });

  it("wraps a closed mermaid fence and keeps its code block inside", () => {
    const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```\n\nAfter.");

    expect(html).toMatch(
      /^<t3-mermaid><pre><code class="language-mermaid">graph TD\n {2}A --&gt; B\n<\/code><\/pre><\/t3-mermaid>/,
    );
  });

  it("keeps a mermaid fence that is still streaming as a plain code block", () => {
    const html = renderMarkdown("Here:\n\n```mermaid\ngraph TD\n  A -->");

    expect(html).not.toContain("t3-mermaid");
    expect(html).toContain('<code class="language-mermaid">');
  });

  it("finds mermaid fences nested in lists", () => {
    const html = renderMarkdown("- Diagram:\n\n  ```mermaid\n  graph TD\n  ```\n");

    expect(html).toContain("<t3-mermaid>");
  });
});
