/** Fork: user insights. Shared test fixtures. */
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");

/** A `message.updated` event of a message the user typed on web. */
export function userMessageEvent(
  overrides: Record<string, unknown> = {},
  text = "Bitte noch die Tests laufen lassen",
): OrchestrationV2DomainEvent {
  return {
    id: "event-1",
    threadId: "thread-1",
    occurredAt: at,
    type: "message.updated",
    payload: {
      id: "message-1",
      threadId: "thread-1",
      runId: null,
      nodeId: null,
      role: "user",
      createdBy: "user",
      creationSource: "web",
      text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    },
  } as unknown as OrchestrationV2DomainEvent;
}
