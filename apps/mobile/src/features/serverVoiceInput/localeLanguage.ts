/** The language part of a locale such as `de-DE`, when it is a plain language code. */
export function localeLanguage(locale: string): string | null {
  const language = locale.split(/[-_]/)[0]?.toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(language) ? language : null;
}
