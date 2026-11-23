export function isFenceClosed(source: string): boolean {
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(source)?.[1];
  if (!opening) return false;
  const lastLine = source.slice(source.lastIndexOf("\n") + 1);
  return new RegExp(`^[ \\t>]*${opening[0]}{${opening.length},}[ \\t]*$`).test(lastLine);
}
