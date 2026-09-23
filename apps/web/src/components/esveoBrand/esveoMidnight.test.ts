import { describe, expect, it } from "vite-plus/test";

import esveoTheme from "../../../../../packages/shared/src/esveoTheme.ts?raw";
import chatComposer from "../chat/ChatComposer.tsx?raw";
import composerPrimaryActions from "../chat/ComposerPrimaryActions.tsx?raw";
import messagesTimeline from "../chat/MessagesTimeline.tsx?raw";

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

  it("matches the theme id the stylesheet is scoped to", () => {
    expect(esveoTheme).toContain('id: "esveo-midnight"');
  });
});
