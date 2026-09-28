import { type PeerMessage, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendToPrompt,
  newlyReceived,
  openRepliesForThread,
  unreadCountByContact,
} from "./peers.logic";

const message = (patch: Partial<PeerMessage>): PeerMessage => ({
  id: "m",
  contactId: "max",
  direction: "in",
  text: "Hi",
  context: null,
  replyToId: null,
  threadId: null,
  status: "unread",
  error: null,
  createdAt: "2026-09-28T10:00:00.000Z",
  updatedAt: "2026-09-28T10:00:00.000Z",
  ...patch,
});

describe("peers logic", () => {
  it("announces only messages that arrived after the first snapshot", () => {
    const first = [message({ id: "old" })];
    expect(newlyReceived(null, first)).toEqual([]);
    const next = [...first, message({ id: "new" }), message({ id: "sent", direction: "out" })];
    expect(newlyReceived(first, next).map((entry) => entry.id)).toEqual(["new"]);
  });

  it("counts unread received messages per contact", () => {
    const counts = unreadCountByContact([
      message({ id: "a" }),
      message({ id: "b", status: "read" }),
      message({ id: "c", contactId: "anna" }),
      message({ id: "d", direction: "out", status: "pending" }),
    ]);
    expect([...counts]).toEqual([
      ["max", 1],
      ["anna", 1],
    ]);
  });

  it("shows open replies in the thread that asked", () => {
    const replies = openRepliesForThread(
      [
        message({ id: "open", threadId: ThreadId.make("t1") }),
        message({ id: "done", threadId: ThreadId.make("t1"), status: "done" }),
        message({ id: "other", threadId: ThreadId.make("t2") }),
      ],
      "t1",
    );
    expect(replies.map((entry) => entry.id)).toEqual(["open"]);
  });

  it("appends to a draft with a blank line in between", () => {
    expect(appendToPrompt("", "Quote")).toBe("Quote\n\n");
    expect(appendToPrompt("My note  \n", "Quote")).toBe("My note\n\nQuote\n\n");
  });
});
