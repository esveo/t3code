import { describe, expect, it } from "vite-plus/test";

import {
  buildPeerInviteLink,
  formatPeerMessageForThread,
  normalizePeerBaseUrl,
  parsePeerInviteLink,
} from "./peers.ts";

describe("peer contact links", () => {
  it("round-trips an address with a path prefix", () => {
    const link = buildPeerInviteLink("https://box.example.com/t3", "s3cret");
    expect(parsePeerInviteLink(` ${link} `)).toEqual({
      baseUrl: "https://box.example.com/t3",
      secret: "s3cret",
    });
  });

  it("rejects links without a secret or with another path", () => {
    expect(parsePeerInviteLink("https://box.example.com/api/fork/peers/invite")).toBeNull();
    expect(parsePeerInviteLink("https://box.example.com/pair#token")).toBeNull();
    expect(parsePeerInviteLink("ftp://box.example.com/api/fork/peers/invite#s")).toBeNull();
  });

  it("normalizes addresses and refuses credentials in them", () => {
    expect(normalizePeerBaseUrl("http://100.64.0.1:3773/")).toBe("http://100.64.0.1:3773");
    expect(normalizePeerBaseUrl("https://user:pw@example.com")).toBeNull();
    expect(normalizePeerBaseUrl("not a url")).toBeNull();
  });
});

describe("formatPeerMessageForThread", () => {
  it("quotes context and text and tells the agent how to answer", () => {
    const text = formatPeerMessageForThread(
      { id: "m1", text: "Line one\n\nLine two", context: "Auth refactor" },
      "Max",
    );
    expect(text).toBe(
      [
        "**Message from Max**",
        "Context:\n> Auth refactor",
        "> Line one\n>\n> Line two",
        '(Peer message m1. To answer it, call send_to_contact with reply_to "m1".)',
      ].join("\n\n"),
    );
  });
});
