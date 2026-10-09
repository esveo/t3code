/**
 * Fork: user insights. How the model's proposed operations change the
 * profile. The model only proposes; this code validates every operation,
 * keeps the counts, and derives confidence, so a bad answer cannot rewrite
 * what was learned.
 */
import {
  USER_INSIGHTS_MAX_TRAIT_VALUE_LENGTH,
  USER_INSIGHTS_READY_CONFIDENCE,
  USER_INSIGHTS_READY_SAMPLES,
  USER_INSIGHTS_READY_TRAITS,
  USER_INSIGHTS_TRAIT_IDS,
  type UserInsightsProfile,
  type UserInsightsTrait,
  type UserInsightsTraitId,
} from "@t3tools/contracts";

import { DAY_MS, fromIso, toIso } from "./time.ts";

export const DECAY_HALF_LIFE_DAYS = 30;
export const STALE_AFTER_DAYS = 60;
export const STALE_BELOW_CONFIDENCE = 0.3;
export const MAX_NOTES = 5;
export const MAX_EXAMPLES = 3;
/**
 * Most observations one operation may claim. Haiku tends to credit every
 * message of a batch to every trait, so one batch moves a trait at most this
 * far and confidence builds over several batches, not one.
 */
export const MAX_OP_COUNT = 3;
/** Support a user edit gives its trait. */
export const PINNED_SUPPORT = 10;

export type DistillOpKind = "add" | "support" | "contradict" | "revise" | "noop";

/** One operation as the model returns it; ids and indexes are not trusted yet. */
export interface DistillOp {
  readonly traitId: string;
  readonly op: DistillOpKind;
  readonly value?: string | null;
  readonly count: number;
  /** 1-based indexes into the excerpts the model was shown. */
  readonly evidence: ReadonlyArray<number>;
}

export interface RejectedOp {
  readonly op: DistillOp;
  readonly reason: string;
}

export const emptyProfile = (now: number): UserInsightsProfile => ({
  schemaVersion: 1,
  updatedAt: toIso(now),
  sampleCount: 0,
  traits: [],
});

const isTraitId = (id: string): id is UserInsightsTraitId =>
  (USER_INSIGHTS_TRAIT_IDS as ReadonlyArray<string>).includes(id);

const isNote = (id: string) => id.startsWith("notes.");

/** `x * 0.5 ^ (days / 30)`: a count halves every 30 days without new evidence. */
export function decay(value: number, elapsedMs: number): number {
  const days = Math.max(0, elapsedMs) / DAY_MS;
  return value * 0.5 ** (days / DECAY_HALF_LIFE_DAYS);
}

/**
 * The lower bound of the support share: a Laplace-smoothed share minus one
 * standard error, so few observations never look confident.
 */
export function confidenceOf(support: number, contradict: number): number {
  const p = (1 + support) / (2 + support + contradict);
  const n = support + contradict;
  return Math.max(0, p - Math.sqrt((p * (1 - p)) / (n + 2)));
}

export type ConfidenceLevel = "low" | "medium" | "high";

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence < 0.5) return "low";
  if (confidence < 0.75) return "medium";
  return "high";
}

/** Checks the model's operations against the taxonomy and the shown excerpts. */
export function validateOps(
  ops: ReadonlyArray<DistillOp>,
  input: { readonly profile: UserInsightsProfile; readonly excerptCount: number },
): { readonly accepted: ReadonlyArray<DistillOp>; readonly rejected: ReadonlyArray<RejectedOp> } {
  const accepted: Array<DistillOp> = [];
  const rejected: Array<RejectedOp> = [];
  const existing = new Map(input.profile.traits.map((trait) => [trait.id as string, trait]));
  const notes = new Set(input.profile.traits.filter((trait) => isNote(trait.id)).map((t) => t.id));
  const touched = new Set<string>();
  for (const op of ops) {
    const reject = (reason: string) => rejected.push({ op, reason });
    if (!isTraitId(op.traitId)) {
      reject("unknown trait id");
      continue;
    }
    if (touched.has(op.traitId)) {
      reject("more than one operation for this trait");
      continue;
    }
    if (op.op === "noop") continue;
    if (
      op.evidence.some(
        (index) => !Number.isInteger(index) || index < 1 || index > input.excerptCount,
      )
    ) {
      reject("evidence index out of range");
      continue;
    }
    const value = op.value?.trim() ?? "";
    if ((op.op === "add" || op.op === "revise") && value.length === 0) {
      reject("missing value");
      continue;
    }
    if (value.length > USER_INSIGHTS_MAX_TRAIT_VALUE_LENGTH) {
      reject("value too long");
      continue;
    }
    const trait = existing.get(op.traitId);
    if ((op.op === "support" || op.op === "contradict" || op.op === "revise") && !trait) {
      reject("trait does not exist");
      continue;
    }
    if (op.op === "revise" && trait?.pinned === true) {
      reject("trait is pinned");
      continue;
    }
    if (op.op === "add" && !trait && isNote(op.traitId)) {
      if (notes.size >= MAX_NOTES) {
        reject("too many notes");
        continue;
      }
      notes.add(op.traitId);
    }
    touched.add(op.traitId);
    accepted.push(op);
  }
  return { accepted, rejected };
}

const withConfidence = (trait: UserInsightsTrait): UserInsightsTrait => ({
  ...trait,
  confidence: confidenceOf(trait.support, trait.contradict),
});

const opCount = (op: DistillOp) =>
  Math.max(1, Math.min(MAX_OP_COUNT, Math.round(Number.isFinite(op.count) ? op.count : 1)));

/**
 * Applies validated operations. `evidenceIds[i]` is the message id of the
 * excerpt the model saw as number `i + 1`. Counts of touched traits decay
 * by the time since they were last seen before the new evidence is added.
 * `weight` scales the new counts, so older evidence (an import) counts less.
 */
export function applyOps(
  profile: UserInsightsProfile,
  ops: ReadonlyArray<DistillOp>,
  input: {
    readonly now: number;
    readonly evidenceIds: ReadonlyArray<string>;
    readonly newSamples: number;
    readonly weight?: number;
  },
): UserInsightsProfile {
  const nowIso = toIso(input.now);
  const weight = Math.min(1, Math.max(0, input.weight ?? 1));
  const traits = new Map(profile.traits.map((trait) => [trait.id as string, trait]));
  for (const op of ops) {
    if (op.op === "noop" || !isTraitId(op.traitId)) continue;
    const count = opCount(op) * weight;
    const examples = op.evidence.flatMap((index) => {
      const id = input.evidenceIds[index - 1];
      return id === undefined ? [] : [id];
    });
    const current = traits.get(op.traitId);
    if (!current) {
      if (op.op !== "add") continue;
      traits.set(
        op.traitId,
        withConfidence({
          id: op.traitId,
          value: (op.value ?? "").trim(),
          support: count,
          contradict: 0,
          confidence: 0,
          lastSeen: nowIso,
          pinned: false,
          examples: examples.slice(-MAX_EXAMPLES),
        }),
      );
      continue;
    }
    const elapsed = input.now - fromIso(current.lastSeen);
    let support = decay(current.support, elapsed);
    let contradict = decay(current.contradict, elapsed);
    let value = current.value;
    if (op.op === "add" || op.op === "support") support += count;
    if (op.op === "contradict") contradict += count;
    if (op.op === "revise") {
      contradict += count;
      // The new value takes over only once the evidence against the old one
      // outweighs the evidence for it; the counts swap sides with it.
      if (!current.pinned && contradict > support) {
        value = (op.value ?? "").trim();
        [support, contradict] = [contradict, support];
      }
    }
    traits.set(
      op.traitId,
      withConfidence({
        ...current,
        value,
        support,
        contradict,
        lastSeen: nowIso,
        examples:
          op.op === "contradict"
            ? current.examples
            : [...current.examples.filter((id) => !examples.includes(id)), ...examples].slice(
                -MAX_EXAMPLES,
              ),
      }),
    );
  }
  return {
    schemaVersion: 1,
    updatedAt: nowIso,
    sampleCount: profile.sampleCount + Math.max(0, input.newSamples),
    traits: dropStale([...traits.values()], input.now),
  };
}

/** Drops unpinned traits that stayed unconvincing and unseen for 60 days. */
export function dropStale(
  traits: ReadonlyArray<UserInsightsTrait>,
  now: number,
): ReadonlyArray<UserInsightsTrait> {
  return traits.filter(
    (trait) =>
      trait.pinned ||
      trait.confidence >= STALE_BELOW_CONFIDENCE ||
      now - fromIso(trait.lastSeen) <= STALE_AFTER_DAYS * DAY_MS,
  );
}

/** Enough samples and enough confident traits, one of them about follow-ups. */
export function isProfileReady(profile: UserInsightsProfile): boolean {
  if (profile.sampleCount < USER_INSIGHTS_READY_SAMPLES) return false;
  const confident = profile.traits.filter(
    (trait) => trait.confidence >= USER_INSIGHTS_READY_CONFIDENCE,
  );
  return (
    confident.length >= USER_INSIGHTS_READY_TRAITS &&
    confident.some((trait) => trait.id === "flow.followups")
  );
}

/** A user edit: sets the value and pins it, so the model can no longer revise it. */
export function editTrait(
  profile: UserInsightsProfile,
  id: UserInsightsTraitId,
  value: string,
  now: number,
): UserInsightsProfile {
  const nowIso = toIso(now);
  const existing = profile.traits.find((trait) => trait.id === id);
  // A user statement counts as strong support of its own.
  const edited = withConfidence({
    id,
    value: value.trim(),
    support: Math.max(existing?.support ?? 0, PINNED_SUPPORT),
    contradict: 0,
    confidence: 0,
    lastSeen: nowIso,
    pinned: true,
    examples: existing?.examples ?? [],
  });
  return {
    ...profile,
    updatedAt: nowIso,
    traits: existing
      ? profile.traits.map((trait) => (trait.id === id ? edited : trait))
      : [...profile.traits, edited],
  };
}

export function deleteTrait(
  profile: UserInsightsProfile,
  id: UserInsightsTraitId,
  now: number,
): UserInsightsProfile {
  return {
    ...profile,
    updatedAt: toIso(now),
    traits: profile.traits.filter((trait) => trait.id !== id),
  };
}
