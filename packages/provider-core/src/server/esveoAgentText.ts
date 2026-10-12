// Fork: agents hear the app's name as esveo code. Wraps upstream's multi-line instruction texts,
// so upstream can keep rewording them without a merge conflict here. Identifiers such as the
// `t3-code` MCP server and the `t3_*` tools keep their names.
export function esveoAgentText(text: string): string {
  return text.replaceAll("T3 Code", "esveo code");
}
