/**
 * Fork: the Peers page. Without contacts it walks through linking; with
 * contacts it is a list of them beside the chosen contact's channel, where
 * received messages are read and handed to a thread. This environment's own
 * link and the settings sit in the header.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  PeerContact,
  PeerMessage,
  PeersSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { normalizePeerBaseUrl, peerMessageExcerpt } from "@t3tools/shared/peers";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  EllipsisIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  SettingsIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SidebarInset } from "~/components/ui/sidebar";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useEnvironmentHttpBaseUrl, useRelayEnvironmentDiscovery } from "~/state/environments";
import { useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { unreadCountByContact } from "./peers.logic";
import {
  useAdoptPeerMessage,
  usePeersAct,
  usePeersEnvironmentId,
  usePeersSnapshot,
  usePeerTargetThreads,
} from "./usePeers";

type Run = ReturnType<typeof usePeersAct>;

export function PeersView({
  contactId,
  onSelectContact,
}: {
  readonly contactId: string | null;
  readonly onSelectContact: (contactId: string) => void;
}) {
  const environmentId = usePeersEnvironmentId();
  const { snapshot, error } = usePeersSnapshot(environmentId);
  const run = usePeersAct(environmentId);
  const detected = useDetectedAddress(environmentId, snapshot?.detectedBaseUrl ?? null);
  const [dialog, setDialog] = useState<"settings" | "add" | null>(null);

  // The address is found, not asked for: once known, it is saved for the link.
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !snapshot || snapshot.ownBaseUrl || !detected) return;
    applied.current = true;
    void run({ type: "configure", ownBaseUrl: detected.url }, "Could not save your address");
  }, [detected, run, snapshot]);

  const selected =
    snapshot?.contacts.find((contact) => contact.id === contactId) ?? snapshot?.contacts[0] ?? null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel="Peers">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Peers</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          {snapshot ? (
            <div className="flex items-center gap-1.5">
              {snapshot.contacts.length > 0 ? (
                <>
                  <CopyLinkButton link={snapshot.inviteLink} />
                  <Button size="sm" variant="outline" onClick={() => setDialog("add")}>
                    <PlusIcon />
                    Add contact
                  </Button>
                </>
              ) : null}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Peers settings"
                onClick={() => setDialog("settings")}
              >
                <SettingsIcon />
              </Button>
            </div>
          ) : null}
        </WorkspacePageHeader>

        {!environmentId ? (
          <Centered>None of your connected servers supports Peers yet. Update the server.</Centered>
        ) : !snapshot ? (
          <Centered>{error ?? "Loading…"}</Centered>
        ) : snapshot.contacts.length === 0 ? (
          <Onboarding
            snapshot={snapshot}
            run={run}
            detected={detected}
            onEditAddress={() => setDialog("settings")}
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            <ContactList
              snapshot={snapshot}
              selectedId={selected?.id ?? null}
              onSelect={onSelectContact}
            />
            {selected ? (
              <Channel environmentId={environmentId} snapshot={snapshot} contact={selected} />
            ) : null}
          </div>
        )}
      </div>

      {snapshot && environmentId ? (
        <>
          <SettingsDialog
            open={dialog === "settings"}
            onOpenChange={(open) => setDialog(open ? "settings" : null)}
            snapshot={snapshot}
            run={run}
            detected={detected}
          />
          <AddContactDialog
            open={dialog === "add"}
            onOpenChange={(open) => setDialog(open ? "add" : null)}
            run={run}
          />
        </>
      ) : null}
    </SidebarInset>
  );
}

interface DetectedAddress {
  readonly url: string;
  readonly source: string;
}

/**
 * Where contacts reach this environment: the T3 Connect address the server
 * knows, else the one the signed-in account lists, else the address this app
 * itself uses when that is not one only this machine can reach.
 */
function useDetectedAddress(
  environmentId: EnvironmentId | null,
  serverKnown: string | null,
): DetectedAddress | null {
  const discovery = useRelayEnvironmentDiscovery();
  const refresh = useAtomCommand(relayEnvironmentDiscovery.refresh, { reportFailure: false });
  const connectionUrl = useEnvironmentHttpBaseUrl(environmentId);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!environmentId) return null;
  // The server keeps its tunnel's address from linking; that needs no sign-in here.
  if (serverKnown) return { url: serverKnown, source: "T3 Connect" };
  for (const entry of discovery.environments.values()) {
    if (entry.environment.environmentId !== environmentId) continue;
    const url = normalizePeerBaseUrl(entry.environment.endpoint.httpBaseUrl);
    if (url) return { url, source: "T3 Connect" };
  }
  const url = connectionUrl ? normalizePeerBaseUrl(connectionUrl) : null;
  if (url && !isLocalOnly(url)) return { url, source: "this connection" };
  return null;
}

function isLocalOnly(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function Centered({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      <div className="max-w-md">{children}</div>
    </div>
  );
}

function CopyLinkButton({ link }: { readonly link: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!link}
      onClick={async () => {
        if (!link) return;
        await navigator.clipboard.writeText(link);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : "Copy my link"}
    </Button>
  );
}

/* Without contacts: the three steps to the first one. */

function Onboarding({
  snapshot,
  run,
  detected,
  onEditAddress,
}: {
  readonly snapshot: PeersSnapshot;
  readonly run: Run;
  readonly detected: DetectedAddress | null;
  readonly onEditAddress: () => void;
}) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const redeem = async (value: string, success: string) => {
    setBusy(true);
    const ok = await run({ type: "redeem", link: value }, "Could not add the contact");
    setBusy(false);
    if (ok) {
      setLink("");
      toastManager.add({ type: "success", title: success });
    }
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-12">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-full bg-muted">
            <MessagesSquareIcon className="size-5 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold">Messages between T3 Code environments</h2>
          <p className="text-sm text-muted-foreground">
            Link your environment with a colleague's. Your agents can then send each other
            questions, prompts and results with send_to_contact, and you decide which thread gets
            them. Contacts can send you messages and nothing else.
          </p>
        </div>

        <ol className="flex flex-col gap-3">
          <Step number={1} title="Your address" done={snapshot.ownBaseUrl !== null}>
            {snapshot.ownBaseUrl ? (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {snapshot.ownBaseUrl}
                </code>
                {snapshot.ownBaseUrl === snapshot.detectedBaseUrl ? (
                  <Badge size="sm" variant="success">
                    T3 Connect
                  </Badge>
                ) : null}
                <Button size="xs" variant="ghost" onClick={onEditAddress}>
                  Change
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  {detected
                    ? "Saving your address…"
                    : "Not found. Sign in to T3 Connect under Settings → Connections, or enter the address other servers reach this one at."}
                </p>
                {detected ? null : (
                  <div>
                    <Button size="xs" variant="outline" onClick={onEditAddress}>
                      Enter address
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Step>

          <Step number={2} title="Share your contact link" done={false}>
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Whoever adds it becomes your contact, on both sides.
              </p>
              <CopyLinkButton link={snapshot.inviteLink} />
            </div>
          </Step>

          <Step number={3} title="Or add someone else's link" done={false}>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (link.trim()) void redeem(link.trim(), "Contact added on both sides");
              }}
            >
              <Input
                size="sm"
                placeholder="https://…/api/fork/peers/invite#…"
                value={link}
                onChange={(event) => setLink(event.target.value)}
              />
              <Button size="sm" type="submit" disabled={busy || !link.trim()}>
                Add
              </Button>
            </form>
          </Step>
        </ol>

        {snapshot.inviteLink ? (
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-xs text-muted-foreground">
              Trying it out alone? Add yourself and send messages to your own environment.
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void redeem(snapshot.inviteLink!, "You are now your own contact")}
            >
              <UserRoundIcon />
              Try it with yourself
            </Button>
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function Step({
  number,
  title,
  done,
  children,
}: {
  readonly number: number;
  readonly title: string;
  readonly done: boolean;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex gap-3 rounded-lg border bg-card p-4">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
          done ? "bg-success/12 text-success-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {done ? <CheckIcon className="size-3.5" /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

/* With contacts. */

function Avatar({ name, className }: { readonly name: string; readonly className?: string }) {
  const initials = name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      {initials || "?"}
    </span>
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
  const latest = useMemo(() => {
    const byContact = new Map<string, PeerMessage>();
    for (const message of snapshot.messages) byContact.set(message.contactId, message);
    return byContact;
  }, [snapshot.messages]);

  return (
    <nav aria-label="Contacts" className="flex w-72 shrink-0 flex-col border-e">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-0.5 p-2">
          {snapshot.contacts.map((contact) => {
            const last = latest.get(contact.id);
            const count = unread.get(contact.id) ?? 0;
            return (
              <li key={contact.id}>
                <button
                  type="button"
                  onClick={() => onSelect(contact.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-start hover:bg-accent",
                    contact.id === selectedId && "bg-accent",
                  )}
                >
                  <Avatar name={contact.name} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-sm",
                          count > 0 && "font-medium",
                        )}
                      >
                        {contact.name}
                        {contact.isSelf ? (
                          <span className="text-muted-foreground"> (you)</span>
                        ) : null}
                      </span>
                      {last ? (
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {formatShortTime(last.createdAt)}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {last
                          ? `${last.direction === "out" ? "You: " : ""}${peerMessageExcerpt(last.text, 80)}`
                          : "No messages yet"}
                      </span>
                      {count > 0 ? <Badge size="sm">{count}</Badge> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </nav>
  );
}

function formatShortTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

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
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <Avatar name={contact.name} />
        <div className="flex min-w-0 flex-1 flex-col">
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
            <span className="truncate text-sm font-medium">
              {contact.name}
              {contact.isSelf ? <span className="text-muted-foreground"> (you)</span> : null}
            </span>
          )}
          <span className="truncate text-xs text-muted-foreground">
            {contact.baseUrl ?? "No address: messages to this contact cannot be delivered"}
          </span>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button size="icon-sm" variant="ghost-muted" aria-label="Contact actions" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setRenaming(contact.name)}>
              <PencilIcon />
              Rename
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
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
              Remove contact
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-5">
          {messages.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No messages yet. Agents send them with send_to_contact, or write one below.
            </p>
          ) : (
            messages.map((message) => (
              <MessageBubble
                key={`${message.direction}:${message.id}`}
                environmentId={environmentId}
                snapshot={snapshot}
                message={message}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <form
        className="mx-auto flex w-full max-w-3xl shrink-0 items-end gap-2 px-6 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          placeholder={`Message ${contact.name} (⌘↩ to send)`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
          }}
        />
        <Button type="submit" size="icon" aria-label="Send" disabled={!draft.trim()}>
          <SendIcon />
        </Button>
      </form>
    </section>
  );
}

const OUT_STATUS_LABELS: Record<string, string> = {
  pending: "Waiting to be delivered",
  delivered: "Delivered",
  failed: "Not delivered",
};

function MessageBubble({
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
    <div className={cn("flex flex-col gap-1", incoming ? "items-start" : "items-end")}>
      <div
        className={cn(
          "flex max-w-[85%] flex-col gap-2 rounded-2xl px-4 py-3",
          incoming ? "rounded-tl-sm border bg-card" : "rounded-tr-sm bg-muted",
        )}
      >
        {message.context ? (
          <p className="border-s-2 ps-2 text-xs text-muted-foreground">{message.context}</p>
        ) : null}
        <div className="text-sm">
          <ChatMarkdown text={message.text} cwd={undefined} environmentId={environmentId} />
        </div>
        {incoming ? <Placement environmentId={environmentId} message={message} /> : null}
        {incoming ? (
          <IncomingActions environmentId={environmentId} snapshot={snapshot} message={message} />
        ) : null}
      </div>
      <div className="flex items-center gap-1.5 px-1 text-2xs text-muted-foreground">
        <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
        {incoming ? null : (
          <>
            <span>·</span>
            <span
              className={cn(
                message.status === "failed" && "text-destructive-foreground",
                message.status === "delivered" && "text-success-foreground",
              )}
            >
              {OUT_STATUS_LABELS[message.status] ?? message.status}
            </span>
          </>
        )}
      </div>
      {!incoming && message.error && message.status !== "delivered" ? (
        <div className="flex max-w-[85%] items-center gap-2 px-1 text-xs text-muted-foreground">
          <span>{message.error}</span>
          {message.status === "failed" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void run({ type: "retry", messageId: message.id }, "Could not retry the message")
              }
            >
              Try again
            </Button>
          ) : null}
        </div>
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
  if (message.status === "done") {
    return (
      <div className="flex justify-end">
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() =>
            void run(
              { type: "setStatus", messageId: message.id, status: "read" },
              "Could not update the message",
            )
          }
        >
          Reopen
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-2">
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
        {snapshot.adoptMode === "send" ? "Send to agent" : "Add to thread"}
      </Button>
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
  if (!threadId && !routing && message.status !== "done") return null;
  const title =
    threads.find((thread) => thread.id === threadId)?.title ?? routing?.threadTitle ?? null;
  const openThread = () => {
    if (!threadId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted/50 px-2.5 py-2 text-xs">
      {threadId ? (
        <p className="flex items-center gap-1.5">
          <CircleCheckIcon className="size-3.5 text-success-foreground" />
          {routing?.outcome === "thread" ? "Routed to" : "Handed to"}
          <button type="button" className="font-medium underline" onClick={openThread}>
            {title ?? "a thread"}
          </button>
        </p>
      ) : routing ? (
        <p>Automatic routing left it here: {routing.reason}</p>
      ) : (
        <p className="text-muted-foreground">Marked done</p>
      )}
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

/* Dialogs. */

function AddContactDialog({
  open,
  onOpenChange,
  run,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly run: Run;
}) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!link.trim()) return;
    setBusy(true);
    const ok = await run({ type: "redeem", link: link.trim() }, "Could not add the contact");
    setBusy(false);
    if (ok) {
      setLink("");
      onOpenChange(false);
      toastManager.add({ type: "success", title: "Contact added on both sides" });
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a contact</DialogTitle>
          <DialogDescription>
            Paste the contact link someone gave you. You both become each other's contact.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Input
              autoFocus
              placeholder="https://…/api/fork/peers/invite#…"
              value={link}
              onChange={(event) => setLink(event.target.value)}
            />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !link.trim()} onClick={submit}>
            {busy ? "Linking…" : "Add contact"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const ADOPT_MODE_LABELS = {
  composer: "Put it into the composer",
  send: "Send it to the agent",
} as const;

function SettingsDialog({
  open,
  onOpenChange,
  snapshot,
  run,
  detected,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly snapshot: PeersSnapshot;
  readonly run: Run;
  readonly detected: DetectedAddress | null;
}) {
  const [name, setName] = useState(snapshot.ownName);
  const [address, setAddress] = useState(snapshot.ownBaseUrl ?? "");
  // Opening the dialog starts from what is saved.
  const [openedFor, setOpenedFor] = useState(open);
  if (open !== openedFor) {
    setOpenedFor(open);
    if (open) {
      setName(snapshot.ownName);
      setAddress(snapshot.ownBaseUrl ?? "");
    }
  }

  const save = async () => {
    const trimmed = address.trim();
    const normalized = trimmed ? normalizePeerBaseUrl(trimmed) : null;
    if (trimmed && !normalized) {
      toastManager.add({ type: "error", title: "That is no http(s) address" });
      return;
    }
    const ok = await run(
      {
        type: "configure",
        ...(name.trim() && name.trim() !== snapshot.ownName ? { ownName: name.trim() } : {}),
        ...(normalized !== snapshot.ownBaseUrl ? { ownBaseUrl: normalized } : {}),
      },
      "Could not save the settings",
    );
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Peers settings</DialogTitle>
          <DialogDescription>How contacts see and reach this environment.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-5">
            <Field label="Your name" hint="Contacts see it when you link; they can rename you.">
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </Field>

            <Field
              label="Your address"
              hint={
                detected
                  ? `Found via ${detected.source}. Contacts' servers deliver your messages here.`
                  : "Where contacts' servers reach this one, e.g. your T3 Connect or Tailscale address."
              }
            >
              <div className="flex items-center gap-2">
                <Input
                  placeholder="https://…"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                />
                {detected && detected.url !== address.trim() ? (
                  <Button size="sm" variant="outline" onClick={() => setAddress(detected.url)}>
                    Use detected
                  </Button>
                ) : null}
              </div>
            </Field>

            <Field
              label="Your contact link"
              hint="A new link stops the old one from working; existing contacts stay."
            >
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs">
                  {snapshot.inviteLink ?? "Set your address first"}
                </code>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="New contact link"
                  disabled={!snapshot.inviteLink}
                  onClick={() =>
                    void run({ type: "regenerateInvite" }, "Could not create a new contact link")
                  }
                >
                  <RefreshCwIcon />
                </Button>
              </div>
            </Field>

            <Field
              label="Handing a message to a thread"
              hint="What “Add to thread” and “Take over” do with a received message."
            >
              <Select
                value={snapshot.adoptMode}
                onValueChange={(value) => {
                  if (value !== "composer" && value !== "send") return;
                  void run({ type: "configure", adoptMode: value }, "Could not save the setting");
                }}
              >
                <SelectTrigger aria-label="Handing a message to a thread">
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
            </Field>

            <div className="flex flex-col gap-1.5 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">Route messages automatically</span>
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
                A model reads each received message and sends it to the agent of the active thread
                it belongs to; answers go back to the thread that asked. What it cannot place stays
                in the channel. Model: {snapshot.routingModel ?? "the text generation model"}{" "}
                (Settings → General).
              </p>
              {snapshot.autoRoute ? (
                <p className="text-xs text-warning-foreground">
                  Your contacts' messages then reach your agents without you reading them first.
                </p>
              ) : null}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}
