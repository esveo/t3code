/** Fork: the fork's own strings (`scripts/fork/i18n-generate.ts`) on top of upstream's catalog. */
export async function withForkTranslations(locale: string, upstream: unknown): Promise<unknown> {
  const fork: { default: Record<string, unknown> } = await import(`./fork/${locale}.json`);
  return { ...(upstream as Record<string, unknown>), ...fork.default };
}
