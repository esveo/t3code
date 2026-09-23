import { describe, expect, it } from "vite-plus/test";

import esveoTheme from "../../../../../packages/shared/src/esveoTheme.ts?raw";
import chatComposer from "../chat/ChatComposer.tsx?raw";
import composerPrimaryActions from "../chat/ComposerPrimaryActions.tsx?raw";
import messagesTimeline from "../chat/MessagesTimeline.tsx?raw";
import sidebar from "../Sidebar.tsx?raw";
import toast from "../ui/toast.tsx?raw";

// esveoMidnight.css styles upstream's markup through the classes and data
// attributes it already renders. When an upstream merge renames one, the
// gradient silently disappears; this fails instead.
describe("esveo Midnight gradient hooks", () => {
  it("finds the user's message bubble", () => {
    expect(messagesTimeline).toMatch(/className="[^"]*\bbg-message\s/);
  });

  it("finds the composer's send actions", () => {
    expect(composerPrimaryActions).toMatch(/\bbg-message-action\s/);
    expect(composerPrimaryActions).toContain("data-chat-composer-implement-actions");
    expect(chatComposer).toMatch(/\bbg-message-action\s/);
  });

  it("finds the current thread's sidebar row", () => {
    expect(sidebar).toMatch(/"bg-sidebar-row-active\s/);
  });

  it("finds the stacked toast surface and its primary action", () => {
    expect(toast).toContain('data-slot="toast-viewport"');
    expect(toast).toMatch(/"dropdown-glass absolute\s/);
    expect(toast).toContain('data-slot="toast-action"');
    expect(toast).toContain('data-slot="toast-description"');
  });

  it("finds the row ids the live message marker targets", () => {
    expect(messagesTimeline).toContain("data-timeline-row-id={row.id}");
    expect(messagesTimeline).toContain("<LiveUserMessageMarker");
  });

  it("matches the theme id the stylesheet is scoped to", () => {
    expect(esveoTheme).toContain('id: "esveo-midnight"');
  });
});
