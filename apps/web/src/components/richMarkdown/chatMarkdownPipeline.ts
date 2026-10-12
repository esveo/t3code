import {
  CHAT_MARKDOWN_REHYPE_PLUGINS as UPSTREAM_CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS as UPSTREAM_CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS as UPSTREAM_CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_MARKDOWN_SANITIZE_SCHEMA,
} from "@t3tools/shared/markdownPipeline";
import type { PluggableList } from "unified";

import { RICH_MARKDOWN_REMARK_PLUGINS, withRichMarkdownSanitizeSchema } from "./remarkRichMarkdown";

/**
 * Fork: upstream's shared chat pipeline plus math and mermaid. The rich plugins
 * run right after remark-gfm, where the fork always had them.
 */
function withRichRemarkPlugins(plugins: PluggableList): PluggableList {
  const [gfm, ...rest] = plugins;
  return gfm === undefined
    ? [...RICH_MARKDOWN_REMARK_PLUGINS]
    : [gfm, ...RICH_MARKDOWN_REMARK_PLUGINS, ...rest];
}

export const CHAT_MARKDOWN_REMARK_PLUGINS = withRichRemarkPlugins(
  UPSTREAM_CHAT_MARKDOWN_REMARK_PLUGINS,
);

export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS = withRichRemarkPlugins(
  UPSTREAM_CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
);

/** The sanitizer lets the fork's math and mermaid elements through. */
export const CHAT_MARKDOWN_REHYPE_PLUGINS: PluggableList =
  UPSTREAM_CHAT_MARKDOWN_REHYPE_PLUGINS.map((plugin) =>
    Array.isArray(plugin) && plugin[1] === CHAT_MARKDOWN_SANITIZE_SCHEMA
      ? [plugin[0], withRichMarkdownSanitizeSchema(CHAT_MARKDOWN_SANITIZE_SCHEMA)]
      : plugin,
  );
