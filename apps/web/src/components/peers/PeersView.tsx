/**
 * Fork: the Peers page. Contacts on the left with this environment's own
 * contact link and settings; the channel of the chosen contact on the right,
 * where received messages are read and handed to a thread.
 */
import type {
  EnvironmentId,
  PeerContact,
  PeerMessage,
  PeersSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { normalizePeerBaseUrl } from "@t3tools/shared/peers";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CopyIcon,
  MessagesSquareIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useRelayEnvironmentDiscovery } from "~/state/environments";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { unreadCountByContact } from "./peers.logic";
import {
  useAdoptPeerMessage,
  usePeersAct,
  usePeersEnvironmentId,
  usePeersSnapshot,
  usePeerTargetThreads,
} from "./usePeers";

export function PeersView({
  contactId,
  onSelectContact,
  onClose,
}: {
  readonly contactId: string | null;
  readonly onSelectContact: (contactId: string) => void;
  readonly onClose: () => void;
}) {
  const environmentId = usePeersEnvironmentId();
  const { snapshot, error } = usePeersSnapshot(environmentId);
  const selected =
    snapshot?.contacts.find((contact) => contact.id === contactId) ?? snapshot?.contacts[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <MessagesSquareIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Peers</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          Messages between your environment and your contacts'
        </span>
        <div className="ms-auto">
          <Button variant="ghost" size="icon-sm" aria-label="Close Peers" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
      </header>
      {!environmentId ? (
        <Centered>None of your connected servers supports Peers yet. Update the server.</Centered>
      ) : !snapshot ? (
        <Centered>{error ?? "Loading…"}</Centered>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-80 shrink-0 flex-col border-e">
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-5 p-4">
                <ContactList
                  snapshot={snapshot}
                  selectedId={selected?.id ?? null}
                  onSelect={onSelectContact}
                />
                <AddContact environmentId={environmentId} />
                <OwnSettings
                  // A change from elsewhere resets the fields to the saved values.
                  key={`${snapshot.ownName}\n${snapshot.ownBaseUrl ?? ""}`}
                  environmentId={environmentId}
                  snapshot={snapshot}
                />
              </div>
            </ScrollArea>
          </aside>
          <section className="flex min-w-0 flex-1 flex-col">
            {selected ? (
              <Channel environmentId={environmentId} snapshot={snapshot} contact={selected} />
            ) : (
              <Centered>
                No contacts yet. Share your contact link, or paste someone's link on the left. You
                can also paste your own to send messages to yourself.
              </Centered>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Centered({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      <p className="max-w-md">{children}</p>
    </div>
  );
}

function SectionTitle({ children }: { readonly children: ReactNode }) {
  return (
    <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

function ContactList({
  snapshot,
  selectedId,
  onSelect,
}: {
  readonly snapshot: PeersSnapshot;
  readonly selectedId: string | null;
  readonly onSelect: (contactId: string) => void;
}) {
  const unread = useMemo(() => unreadCountByContact(snapshot.messages), [snapshot.messages]);
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>Contacts</SectionTitle>
      {snapshot.contacts.length === 0 ? (
        <p className="text-xs text-muted-foreground">No contacts yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {snapshot.contacts.map((contact) => (
            <li key={contact.id}>
              <button
                type="button"
                onClick={() => onSelect(contact.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent",
                  contact.id === selectedId && "bg-accent",
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {contact.name}
                  {contact.isSelf ? <span className="text-muted-foreground"> (you)</span> : null}
                </span>
                {(unread.get(contact.id) ?? 0) > 0 ? (
                  <Badge size="sm">{unread.get(contact.id)}</Badge>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddContact({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const run = usePeersAct(environmentId);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!link.trim()) return;
    setBusy(true);
    const ok = await run({ type: "redeem", link: link.trim() }, "Could not add the contact");
    setBusy(false);
    if (ok) {
      setLink("");
      toastManager.add({ type: "success", title: "Contact added on both sides" });
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>Add a contact</SectionTitle>
      <Input
        size="sm"
        placeholder="Paste a contact link"
        value={link}
        onChange={(event) => setLink(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
      />
      <Button size="sm" variant="outline" disabled={busy || !link.trim()} onClick={submit}>
        {busy ? "Linking…" : "Add contact"}
      </Button>
    </div>
  );
}

/** Addresses this environment is reachable at, as far as the client knows them. */
function useAddressSuggestions(environmentId: EnvironmentId): ReadonlyArray<string> {
  const discovery = useRelayEnvironmentDiscovery();
  return useMemo(() => {
    const suggestions = new Set<string>();
    const relay = discovery.environments.get(environmentId);
    if (relay) suggestions.add(relay.environment.endpoint.httpBaseUrl);
    for (const entry of discovery.environments.values()) {
      if (entry.environment.environmentId === environmentId) {
        suggestions.add(entry.environment.endpoint.httpBaseUrl);
      }
    }
    return [...suggestions].flatMap((url) => {
      const normalized = normalizePeerBaseUrl(url);
      return normalized ? [normalized] : [];
    });
  }, [discovery.environments, environmentId]);
}

function OwnSettings({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: PeersSnapshot;
}) {
  const run = usePeersAct(environmentId);
  const suggestions = useAddressSuggestions(environmentId);
  const [name, setName] = useState(snapshot.ownName);
  const [address, setAddress] = useState(snapshot.ownBaseUrl ?? "");
  const [copied, setCopied] = useState(false);

  const saveAddress = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      await run({ type: "configure", ownBaseUrl: null }, "Could not save the address");
      return;
    }
    const normalized = normalizePeerBaseUrl(trimmed);
    if (!normalized) {
      toastManager.add({ type: "error", title: "That is no http(s) address" });
      return;
    }
    if (normalized !== snapshot.ownBaseUrl) {
      await run({ type: "configure", ownBaseUrl: normalized }, "Could not save the address");
    }
  };
  const copyLink = async () => {
    if (!snapshot.inviteLink) return;
    await navigator.clipboard.writeText(snapshot.inviteLink);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <SectionTitle>Your contact link</SectionTitle>
        <p className="text-xs text-muted-foreground">
          Whoever adds it becomes your contact, on both sides. Contacts can send you messages,
          nothing else.
        </p>
        {snapshot.inviteLink ? (
          <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-xs">
              {snapshot.inviteLink}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copy contact link"
              onClick={copyLink}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="New contact link"
                    onClick={() =>
                      void run({ type: "regenerateInvite" }, "Could not create a new contact link")
                    }
                  >
                    <RefreshCwIcon />
                  </Button>
                }
              />
              <TooltipPopup side="top">
                New link: the old one stops working, existing contacts stay
              </TooltipPopup>
            </Tooltip>
          </div>
        ) : (
          <p className="text-xs text-warning-foreground">
            Set the address contacts reach you at first.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>Your address</SectionTitle>
        <p className="text-xs text-muted-foreground">
          Where contacts' servers reach this one: your T3 Connect or Tailscale address. Without it,
          contacts cannot answer you.
        </p>
        <Input
          size="sm"
          placeholder="https://…"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onBlur={() => void saveAddress(address)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void saveAddress(address);
          }}
        />
        {suggestions
          .filter((suggestion) => suggestion !== snapshot.ownBaseUrl)
          .map((suggestion) => (
            <Button
              key={suggestion}
              size="sm"
              variant="ghost-muted"
              onClick={() => void saveAddress(suggestion)}
            >
              <span className="truncate">Use {suggestion}</span>
            </Button>
          ))}
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>Your name</SectionTitle>
        <Input
          size="sm"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            if (name.trim() && name.trim() !== snapshot.ownName) {
              void run({ type: "configure", ownName: name.trim() }, "Could not save the name");
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          Contacts see it when you link; they can rename you on their side.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>Handing a message to a thread</SectionTitle>
        <Select
          value={snapshot.adoptMode}
          onValueChange={(value) => {
            if (value !== "composer" && value !== "send") return;
            void run({ type: "configure", adoptMode: value }, "Could not save the setting");
          }}
        >
          <SelectTrigger size="sm" aria-label="Handing a message to a thread">
            <SelectValue>{ADOPT_MODE_LABELS[snapshot.adoptMode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {Object.entries(ADOPT_MODE_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <SectionTitle>Route messages automatically</SectionTitle>
          <Switch
            checked={snapshot.autoRoute}
            aria-label="Route messages automatically"
            onCheckedChange={(checked) =>
              void run(
                { type: "configure", autoRoute: Boolean(checked) },
                "Could not save the setting",
              )
            }
          />
        </div>
        <p className="text-xs text-muted-foreground">
          A model reads each received message and sends it to the agent of the active thread it
          belongs to. Answers go back to the thread that asked. Messages it cannot place stay here.
          Model: {snapshot.routingModel ?? "the text generation model"} (Settings → General).
        </p>
        {snapshot.autoRoute ? (
          <p className="text-xs text-warning-foreground">
            Your contacts' messages then reach your agents without you reading them first.
          </p>
        ) : null}
      </div>
    </div>
  );
}

const ADOPT_MODE_LABELS = {
  composer: "Put it into the composer",
  send: "Send it to the agent",
} as const;

function Channel({
  environmentId,
  snapshot,
  contact,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: PeersSnapshot;
  readonly contact: PeerContact;
}) {
  const run = usePeersAct(environmentId);
  const messages = useMemo(
    () => snapshot.messages.filter((message) => message.contactId === contact.id),
    [contact.id, snapshot.messages],
  );
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  // Opening the channel reads what arrived.
  const unreadIds = messages
    .filter((message) => message.direction === "in" && message.status === "unread")
    .map((message) => message.id)
    .join(",");
  useEffect(() => {
    for (const id of unreadIds ? unreadIds.split(",") : []) {
      void run(
        { type: "setStatus", messageId: id, status: "read" },
        "Could not update the message",
      );
    }
  }, [run, unreadIds]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await run({ type: "send", contactId: contact.id, text }, "Could not send the message")) {
      setDraft("");
    }
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        {renaming !== null ? (
          <Input
            size="sm"
            autoFocus
            value={renaming}
            onChange={(event) => setRenaming(event.target.value)}
            onBlur={() => {
              if (renaming.trim() && renaming.trim() !== contact.name) {
                void run(
                  { type: "renameContact", contactId: contact.id, name: renaming.trim() },
                  "Could not rename the contact",
                );
              }
              setRenaming(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 truncate text-sm font-medium"
            aria-label={`Rename ${contact.name}`}
            onClick={() => setRenaming(contact.name)}
          >
            {contact.name}
            {contact.isSelf ? <span className="text-muted-foreground"> (you)</span> : null}
          </button>
        )}
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {contact.baseUrl ?? "No address: messages to this contact cannot be delivered"}
        </span>
        <div className="ms-auto">
          <Button
            variant="ghost-destructive"
            size="icon-sm"
            aria-label="Remove contact"
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${contact.name}? Its messages go too, and it can no longer send you any.`,
                )
              ) {
                void run(
                  { type: "removeContact", contactId: contact.id },
                  "Could not remove the contact",
                );
              }
            }}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-4">
          {messages.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              No messages yet. Agents send them with send_to_contact, or write one below.
            </p>
          ) : (
            messages.map((message) => (
              <MessageRow
                key={`${message.direction}:${message.id}`}
                environmentId={environmentId}
                snapshot={snapshot}
                message={message}
              />
            ))
          )}
        </div>
      </ScrollArea>
      <div className="flex shrink-0 items-end gap-2 border-t p-3">
        <Textarea
          placeholder={`Message to ${contact.name}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
          }}
        />
        <Button size="icon" aria-label="Send" disabled={!draft.trim()} onClick={send}>
          <SendIcon />
        </Button>
      </div>
    </>
  );
}

const OUT_STATUS_LABELS: Record<string, string> = {
  pending: "Waiting to be delivered",
  delivered: "Delivered",
  failed: "Not delivered",
};

function MessageRow({
  environmentId,
  snapshot,
  message,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: PeersSnapshot;
  readonly message: PeerMessage;
}) {
  const run = usePeersAct(environmentId);
  const incoming = message.direction === "in";
  return (
    <div
      className={cn(
        "flex max-w-[80%] flex-col gap-1.5 rounded-lg border p-3",
        incoming ? "self-start bg-card" : "self-end bg-muted/40",
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{incoming ? "Received" : "Sent"}</span>
        <span>·</span>
        <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
        {incoming ? (
          message.status === "done" ? (
            <Badge size="sm" variant="secondary">
              Done
            </Badge>
          ) : null
        ) : (
          <Badge
            size="sm"
            variant={
              message.status === "failed"
                ? "error"
                : message.status === "delivered"
                  ? "success"
                  : "secondary"
            }
          >
            {OUT_STATUS_LABELS[message.status] ?? message.status}
          </Badge>
        )}
      </div>
      {message.context ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Context:</span> {message.context}
        </p>
      ) : null}
      <div className="text-sm">
        <ChatMarkdown text={message.text} cwd={undefined} environmentId={environmentId} />
      </div>
      {!incoming && message.error ? (
        <p className="text-xs text-muted-foreground">{message.error}</p>
      ) : null}
      {!incoming && message.status === "failed" ? (
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run({ type: "retry", messageId: message.id }, "Could not retry the message")
            }
          >
            Try again
          </Button>
        </div>
      ) : null}
      {incoming ? <Placement environmentId={environmentId} message={message} /> : null}
      {incoming ? (
        <IncomingActions environmentId={environmentId} snapshot={snapshot} message={message} />
      ) : null}
    </div>
  );
}

function IncomingActions({
  environmentId,
  snapshot,
  message,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: PeersSnapshot;
  readonly message: PeerMessage;
}) {
  const run = usePeersAct(environmentId);
  const adopt = useAdoptPeerMessage(environmentId, snapshot);
  const threads = usePeerTargetThreads(environmentId);
  const [threadId, setThreadId] = useState<ThreadId | null>(message.threadId);
  const target = threads.find((thread) => thread.id === threadId) ?? null;
  const adoptLabel = snapshot.adoptMode === "send" ? "Send to agent" : "Add to thread";

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <Select
        value={threadId ?? ""}
        onValueChange={(value) => setThreadId(value ? (value as ThreadId) : null)}
      >
        <SelectTrigger size="sm" className="w-56" aria-label="Thread">
          <SelectValue>{target ? target.title : "Choose a thread…"}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {threads.length === 0 ? (
            <SelectItem value="" disabled>
              No active threads
            </SelectItem>
          ) : (
            threads.map((thread) => (
              <SelectItem key={thread.id} hideIndicator value={thread.id}>
                {thread.pinnedAt ? "📌 " : ""}
                {thread.title}
              </SelectItem>
            ))
          )}
        </SelectPopup>
      </Select>
      <Button
        size="sm"
        disabled={!target}
        onClick={() => {
          if (target) void adopt(message, target.id);
        }}
      >
        {adoptLabel}
      </Button>
      {message.status === "done" ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void run(
              { type: "setStatus", messageId: message.id, status: "read" },
              "Could not update the message",
            )
          }
        >
          Reopen
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void run(
              { type: "setStatus", messageId: message.id, status: "done" },
              "Could not update the message",
            )
          }
        >
          Mark done
        </Button>
      )}
    </div>
  );
}

/** Where a received message went, and for automatic routing, how that was decided. */
function Placement({
  environmentId,
  message,
}: {
  readonly environmentId: EnvironmentId;
  readonly message: PeerMessage;
}) {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const routing = message.routing;
  const threadId = message.status === "done" ? message.threadId : null;
  const title =
    threads.find((thread) => thread.id === threadId)?.title ?? routing?.threadTitle ?? null;
  const openThread = () => {
    if (!threadId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };
  if (!threadId && !routing) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted/40 px-2 py-1.5 text-xs">
      {threadId ? (
        <p>
          {routing?.outcome === "thread" ? "Routed to " : "Handed to "}
          <button type="button" className="font-medium underline" onClick={openThread}>
            {title ?? "a thread"}
          </button>
        </p>
      ) : routing ? (
        <p>Automatic routing left it here: {routing.reason}</p>
      ) : null}
      {routing && (routing.model || routing.steps.length > 0) ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">How it was routed</summary>
          <div className="flex flex-col gap-1.5 pt-1.5">
            <p className="text-muted-foreground">
              {routing.model ? `Model: ${routing.model}` : "No model asked"} ·{" "}
              {new Date(routing.decidedAt).toLocaleString()}
            </p>
            {routing.steps.length > 0 ? (
              <ol className="list-decimal ps-4">
                {routing.steps.map((step, index) => (
                  // Steps are an ordered list of plain strings that never reorder.
                  // oxlint-disable-next-line react/no-array-index-key
                  <li key={`${index}:${step}`}>{step}</li>
                ))}
              </ol>
            ) : null}
            <p>
              <span className="font-medium">Reason:</span> {routing.reason}
            </p>
            {routing.candidates.length > 0 ? (
              <p className="text-muted-foreground">
                Threads it chose from:{" "}
                {routing.candidates
                  .map((candidate) =>
                    candidate.project
                      ? `${candidate.title} (${candidate.project})`
                      : candidate.title,
                  )
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
