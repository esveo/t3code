// Fork: user-facing agent instructions use the fork's product name while
// protocol identifiers such as `t3-code` and `t3_*` remain unchanged.
export function esveoAgentText(text: string): string {
  return text.replaceAll("T3 Code", "esveo code");
}
