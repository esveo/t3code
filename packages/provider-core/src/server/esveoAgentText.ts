// Fork: identifiers keep their upstream names while user-facing agent instructions use esveo code.
export function esveoAgentText(text: string): string {
  return text.replaceAll("T3 Code", "esveo code");
}
