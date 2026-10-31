import type {
  ThreadId,
  VoiceCallDelegation,
  VoiceCallEvent,
  VoiceCallStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canBringVoiceCallHere,
  EMPTY_VOICE_CALL_VIEW,
  reduceVoiceCallEvent,
  voiceCallConnectTarget,
  voiceCallModelLabel,
} from "./voiceCallState";

const HERE = "thread-here" as ThreadId;
const THERE = "thread-there" as ThreadId;
const statusOf = (
  state: VoiceCallStatus["state"],
  targetThreadId: ThreadId | null,
  ownerClientId = "me",
) => ({ state, targetThreadId, ownerClientId }) as VoiceCallStatus;

describe("canBringVoiceCallHere", () => {
  it("offers the move on another thread to the owner of a running call", () => {
    expect(canBringVoiceCallHere(statusOf("live", THERE), "me", HERE)).toBe(true);
    expect(canBringVoiceCallHere(statusOf("connecting", THERE), "me", HERE)).toBe(true);
  });

  it("offers it to any client while the call is paused", () => {
    expect(canBringVoiceCallHere(statusOf("paused", THERE, "other"), "me", HERE)).toBe(true);
  });

  it("offers it to a call without a thread", () => {
    expect(canBringVoiceCallHere(statusOf("live", null), "me", HERE)).toBe(true);
  });

  it("does not offer it on the call's own thread, to a watcher or without a call", () => {
    expect(canBringVoiceCallHere(statusOf("live", HERE), "me", HERE)).toBe(false);
    expect(canBringVoiceCallHere(statusOf("live", THERE, "other"), "me", HERE)).toBe(false);
    expect(canBringVoiceCallHere(statusOf("ended", THERE), "me", HERE)).toBe(false);
    expect(canBringVoiceCallHere(null, "me", HERE)).toBe(false);
  });
});

describe("voiceCallConnectTarget", () => {
  it("keeps the thread of a call that resumes or is taken over elsewhere", () => {
    expect(voiceCallConnectTarget(statusOf("paused", THERE), HERE)).toBe(THERE);
    expect(voiceCallConnectTarget(statusOf("live", THERE, "other"), HERE)).toBe(THERE);
    expect(voiceCallConnectTarget(statusOf("paused", null), HERE)).toBe(null);
  });

  it("starts a new call on the thread it is started from", () => {
    expect(voiceCallConnectTarget(null, HERE)).toBe(HERE);
    expect(voiceCallConnectTarget(statusOf("ended", THERE), HERE)).toBe(HERE);
    expect(voiceCallConnectTarget(statusOf("error", THERE), HERE)).toBe(HERE);
  });
});

describe("voiceCallModelLabel", () => {
  it("shortens model names to what tells them apart", () => {
    expect(voiceCallModelLabel("Claude Opus 5.5")).toBe("Opus 5.5");
    expect(voiceCallModelLabel("GPT-6 Astra")).toBe("GPT-6");
    expect(voiceCallModelLabel("GPT-5.6 Sol")).toBe("GPT-5.6");
    expect(voiceCallModelLabel("Grok 4")).toBe("Grok 4");
  });
});

const reduce = (events: ReadonlyArray<VoiceCallEvent>) =>
  events.reduce<typeof EMPTY_VOICE_CALL_VIEW>(
    (view, event, index) => reduceVoiceCallEvent(view, event, index),
    EMPTY_VOICE_CALL_VIEW,
  );

const transcript = (turnId: string, text: string, done: boolean): VoiceCallEvent => ({
  type: "transcript",
  speaker: "voice",
  turnId,
  text,
  done,
});

const call = (startedAt: string) =>
  ({ type: "call", call: { startedAt } as VoiceCallStatus }) as VoiceCallEvent;

describe("reduceVoiceCallEvent", () => {
  it("appends deltas to their turn and lets the final text replace them", () => {
    const view = reduce([
      transcript("a", "Hal", false),
      transcript("b", "Other", false),
      transcript("a", "lo", false),
    ]);
    expect(view.transcript.map((entry) => entry.text)).toEqual(["Hallo", "Other"]);
    expect(reduceVoiceCallEvent(view, transcript("a", "Hallo!", true)).transcript[0]?.text).toBe(
      "Hallo!",
    );
  });

  it("times a turn from its first event to done", () => {
    const view = reduce([
      transcript("a", "", false),
      transcript("a", "Hal", false),
      transcript("a", "Hallo", true),
    ]);
    expect(view.transcript[0]).toMatchObject({ startedAt: 0, endedAt: 2 });
  });

  it("ends a delegation's span when it stops being open, and only once", () => {
    const delegation = (status: VoiceCallDelegation["status"]): VoiceCallEvent => ({
      type: "delegation",
      delegation: { id: "d", status } as VoiceCallDelegation,
    });
    const view = reduce([
      delegation("open"),
      delegation("open"),
      delegation("answered"),
      delegation("answered"),
    ]);
    expect(view.delegationSpans.d).toEqual({ startedAt: 0, endedAt: 2 });
  });

  it("keeps the transcript through a retried segment and clears it for a new call", () => {
    const first = reduce([call("t1"), transcript("a", "Hallo", true)]);
    expect(reduceVoiceCallEvent(first, call("t1")).transcript).toHaveLength(1);
    expect(reduceVoiceCallEvent(first, call("t2")).transcript).toEqual([]);
  });
});
