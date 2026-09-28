import * as Effect from "effect/Effect";

import * as Peers from "../../../peers/Peers.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PeersToolkit } from "./tools.ts";

export const PeersToolkitHandlersLive = PeersToolkit.toLayer(
  Effect.succeed(
    PeersToolkit.of({
      list_contacts: () =>
        Peers.withService((peers) => peers.listContacts).pipe(
          Effect.map((contacts) => ({
            contacts: contacts.map((contact) => ({
              id: contact.id,
              name: contact.name,
              isSelf: contact.isSelf,
              reachable: contact.baseUrl !== null,
            })),
          })),
        ),
      send_to_contact: (input) =>
        Effect.gen(function* () {
          const invocation = yield* McpInvocationContext.McpInvocationContext;
          const { message, contact } = yield* Peers.withService((peers) =>
            peers.send({
              contact: input.contact ?? null,
              text: input.text,
              context: input.context,
              replyToId: input.reply_to ?? null,
              threadId: invocation.threadId,
            }),
          );
          return {
            messageId: message.id,
            contact: contact.name,
            status: message.status,
            error: message.error,
          };
        }),
    }),
  ),
);
