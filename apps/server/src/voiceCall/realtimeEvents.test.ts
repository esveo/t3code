import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { codexAuthFromFile } from "./VoiceCallAuth.ts";
import {
  contextAppendChunks,
  decodeRealtimeEvent,
  delegationAnswerEvents,
} from "./realtimeEvents.ts";

const jwt = (expSeconds: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.sig`;

describe("realtime events", () => {
  it("reads a refused voice as an error the call can show", () => {
    const event = decodeRealtimeEvent({
      type: "error",
      event_id: "event_1",
      error: { message: "Voice session access denied.", type: "", code: "forbidden", param: "" },
    });
    assert.deepEqual(Option.getOrNull(event), {
      type: "error",
      code: "forbidden",
      message: "Voice session access denied.",
    });
  });

  it("ignores audio frames and unknown events", () => {
    assert.isTrue(Option.isNone(decodeRealtimeEvent({ type: "session.output_audio.delta" })));
    assert.isTrue(Option.isNone(decodeRealtimeEvent("not an event")));
  });

  it("splits answers into appends of at most 500 bytes without breaking a character", () => {
    const text = "ä".repeat(400);
    const chunks = contextAppendChunks(text);
    assert.deepEqual(
      chunks.map((chunk) => Buffer.byteLength(chunk)),
      [500, 300],
    );
    assert.equal(chunks.join(""), text);
    const events = delegationAnswerEvents("item_1", text);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, "delegation.context.append");
  });
});

describe("codexAuthFromFile", () => {
  const now = 1_800_000_000_000;
  const file = (authMode: string, exp: number) =>
    JSON.stringify({
      auth_mode: authMode,
      tokens: { access_token: jwt(exp), account_id: "account-1" },
    });

  it("uses a ChatGPT login", () => {
    const result = codexAuthFromFile(file("chatgpt", now / 1000 + 3600), now);
    assert.equal(result._tag, "ready");
  });

  it("refuses an API key login", () => {
    const result = codexAuthFromFile(file("apikey", now / 1000 + 3600), now);
    assert.equal(result._tag === "unavailable" && result.availability.reason, "codex-api-key");
  });

  it("asks for a fresh login when the token is about to expire", () => {
    const result = codexAuthFromFile(file("chatgpt", now / 1000 + 60), now);
    assert.equal(
      result._tag === "unavailable" && result.availability.reason,
      "codex-login-expired",
    );
  });
});
