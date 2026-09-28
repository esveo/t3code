/**
 * Fork: peers. An agent sends single messages to the environments the user
 * linked as contacts. The tools exist only while there is a contact: every
 * MCP session hears when the first contact is linked or the last removed.
 */
import {
  PEER_MESSAGE_CONTEXT_MAX,
  PEER_MESSAGE_TEXT_MAX,
  PeersError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/unstable/ai/McpSchema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { peersToolsOn } from "../../../peers/Peers.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

const ContactSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  isSelf: Schema.Boolean.annotate({
    description: "The user's own environment; messages to it come back to the user here.",
  }),
  reachable: Schema.Boolean.annotate({
    description: "False when the contact gave no address, so messages to it cannot be delivered.",
  }),
});

const ListContactsTool = Tool.make("list_contacts", {
  description:
    "List the contacts the user linked: other people's T3 Code environments you can send a message to with send_to_contact.",
  success: Schema.Struct({ contacts: Schema.Array(ContactSummary) }),
  failure: PeersError,
  dependencies,
})
  .annotate(Tool.Title, "List contacts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, peersToolsOn);

const SendToContactTool = Tool.make("send_to_contact", {
  description:
    "Send one message to a contact (another person's T3 Code environment), for example a question, a prompt for their agent or a result. It lands in their Peers channel; they read it and decide which of their threads gets it, so nothing runs on their side by itself. Send only what the user asked you to send. The contact's answer to this message comes back into this thread for the user. Messages leave the outbox as soon as the contact is reachable; the result says whether it is still pending.",
  parameters: Schema.Struct({
    contact: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "Contact id or name from list_contacts. May be left out when reply_to is given.",
      }),
    ),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(PEER_MESSAGE_TEXT_MAX)).annotate({
      description: "The message itself, in Markdown.",
    }),
    context: TrimmedNonEmptyString.check(Schema.isMaxLength(PEER_MESSAGE_CONTEXT_MAX)).annotate({
      description:
        "What the reader needs to place the message, since they do not see this thread: what it is about, where it comes from (project, repository, branch, what you were working on) and what you expect back. A few sentences.",
    }),
    reply_to: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "The id of a received peer message this one answers (shown with the message as 'Peer message <id>').",
      }),
    ),
  }),
  success: Schema.Struct({
    messageId: Schema.String,
    contact: Schema.String,
    status: Schema.String.annotate({
      description: "pending (in the outbox), delivered, or failed with error.",
    }),
    error: Schema.NullOr(Schema.String),
  }),
  failure: PeersError,
  dependencies,
})
  .annotate(Tool.Title, "Send to contact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, peersToolsOn);

export const PeersToolkit = Toolkit.make(ListContactsTool, SendToContactTool);
