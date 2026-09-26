/**
 * Session statistics and quota estimates. Everything here is an estimate and
 * says so: a provider's quota belongs to an account, not to an initiative,
 * and work in its CLI or desktop app moves the same window. First show, then
 * brake: nothing here stops a start.
 */

export interface StatsSample {
  readonly provider: string;
  readonly model: string | null;
  readonly apiUsd: number | null;
  readonly tokens: number | null;
  readonly durationMs: number | null;
  readonly turns: number | null;
}

export type Range = readonly [low: number, high: number];

/** The middle half of the values: from the first to the third quartile. */
export function middleRange(values: ReadonlyArray<number>): Range | null {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  const at = (fraction: number) => {
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
  };
  return [at(0.25), at(0.75)];
}

export interface Estimate {
  /** How many similar sessions the range comes from. */
  readonly basis: number;
  /** same-model: the same provider and model; same-provider: only the provider matched. */
  readonly match: "same-model" | "same-provider";
  readonly apiUsd: Range | null;
  readonly tokens: Range | null;
  readonly durationMs: Range | null;
  readonly turns: Range | null;
}

/** Below this many similar sessions the range says too little to show. */
export const MIN_ESTIMATE_BASIS = 3;

/**
 * What a session like this one usually takes, from finished similar ones:
 * the same model if there are enough, else the same provider.
 */
export function estimateFrom(
  target: { readonly provider: string; readonly model: string | null },
  samples: ReadonlyArray<StatsSample>,
): Estimate | null {
  const sameModel = samples.filter(
    (sample) => sample.provider === target.provider && sample.model === target.model,
  );
  const sameProvider = samples.filter((sample) => sample.provider === target.provider);
  const [basis, match] =
    sameModel.length >= MIN_ESTIMATE_BASIS
      ? [sameModel, "same-model" as const]
      : [sameProvider, "same-provider" as const];
  if (basis.length < MIN_ESTIMATE_BASIS) return null;
  const pick = (read: (sample: StatsSample) => number | null) =>
    middleRange(
      basis.flatMap((sample) => {
        const value = read(sample);
        return value === null ? [] : [value];
      }),
    );
  return {
    basis: basis.length,
    match,
    apiUsd: pick((sample) => sample.apiUsd),
    tokens: pick((sample) => sample.tokens),
    durationMs: pick((sample) => sample.durationMs),
    turns: pick((sample) => sample.turns),
  };
}

// ── Quota attribution ────────────────────────────────────────────────────

export interface QuotaPoint {
  readonly checkedAtMs: number;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

export interface QuotaSession {
  readonly key: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly tokens: number;
}

export interface QuotaAttribution {
  /** Estimated share of the window per session key, in percentage points. */
  readonly bySession: ReadonlyMap<string, number>;
  /** The rise no measured session explains: other threads, the CLI, the desktop app. */
  readonly unattributed: number;
  /** The rise the observations saw in the current period. */
  readonly observed: number;
  /** Intervals without a session to explain them, or without data on both ends. */
  readonly gaps: number;
}

/**
 * Splits the rise of one quota window between observations among the
 * sessions active in each interval, by their tokens spread over their run
 * time (method "delta"). A reset (the window's reset time moved, or the
 * percentage fell) starts the period again from the new value; it never
 * counts as negative use. Only the current period is attributed.
 */
export function attributeQuota(
  points: ReadonlyArray<QuotaPoint>,
  sessions: ReadonlyArray<QuotaSession>,
): QuotaAttribution {
  const sorted = points.toSorted((a, b) => a.checkedAtMs - b.checkedAtMs);
  // The current period: after the last reset.
  let periodStart = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current.resetsAt !== previous.resetsAt || current.usedPercent < previous.usedPercent) {
      periodStart = index;
    }
  }
  const period = sorted.slice(periodStart);
  const bySession = new Map<string, number>();
  let observed = 0;
  let unattributed = 0;
  let gaps = 0;
  for (let index = 1; index < period.length; index += 1) {
    const from = period[index - 1]!;
    const to = period[index]!;
    const rise = to.usedPercent - from.usedPercent;
    if (rise <= 0) continue;
    observed += rise;
    const weights = sessions.flatMap((session) => {
      const overlap =
        Math.min(session.endMs, to.checkedAtMs) - Math.max(session.startMs, from.checkedAtMs);
      if (overlap <= 0) return [];
      const runtime = Math.max(session.endMs - session.startMs, 1);
      return [{ key: session.key, weight: (session.tokens * overlap) / runtime }];
    });
    const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) {
      unattributed += rise;
      gaps += 1;
      continue;
    }
    for (const entry of weights) {
      bySession.set(entry.key, (bySession.get(entry.key) ?? 0) + (rise * entry.weight) / total);
    }
  }
  // The rise before the first observation of the period nobody saw.
  const first = period[0];
  if (first && first.usedPercent > 0) {
    unattributed += first.usedPercent;
    gaps += 1;
  }
  return { bySession, unattributed, observed, gaps };
}

/** How far to trust an attribution: it only ever is an estimate. */
export function attributionConfidence(input: {
  readonly observations: number;
  readonly gaps: number;
}): "low" | "medium" {
  return input.observations >= 4 && input.gaps <= 1 ? "medium" : "low";
}
