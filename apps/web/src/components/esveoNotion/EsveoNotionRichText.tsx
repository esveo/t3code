import {
  type EnvironmentId,
  type EsveoNotionFileUrlInput,
  type EsveoNotionIcon,
  type EsveoNotionSpan,
  parseNotionPageUrl,
} from "@t3tools/contracts";
import { createContext, type MouseEvent, useContext } from "react";

import { cn } from "~/lib/utils";
import { notionColorClass } from "./notionColors";

/** What the page's parts need from the tab: where to navigate and how to open files. */
export interface NotionViewActions {
  readonly environmentId: EnvironmentId;
  readonly pageId: string;
  readonly pageUrl: string;
  readonly navigate: (pageId: string) => void;
  readonly openFile: (input: EsveoNotionFileUrlInput, fallbackUrl?: string) => void;
  readonly freshFileUrl: (input: EsveoNotionFileUrlInput) => Promise<string | null>;
}

export const NotionViewContext = createContext<NotionViewActions | null>(null);

export function useNotionView(): NotionViewActions {
  const actions = useContext(NotionViewContext);
  if (actions === null) throw new Error("NotionViewContext is missing.");
  return actions;
}

/** A link that stays in the tab when it points at a Notion page; ⌘/Ctrl-click opens the browser. */
export function NotionLink(props: {
  href: string;
  pageId?: string | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  const { navigate } = useNotionView();
  const pageId = props.pageId ?? parseNotionPageUrl(props.href);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (pageId === null || event.metaKey || event.ctrlKey || event.button !== 0) return;
    event.preventDefault();
    navigate(pageId);
  };
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
      className={cn("underline decoration-foreground/30 underline-offset-2", props.className)}
    >
      {props.children}
    </a>
  );
}

function Span({ span }: { span: EsveoNotionSpan }) {
  const className = cn(
    span.bold && "font-semibold",
    span.italic && "italic",
    span.strikethrough && "line-through",
    span.underline && "underline",
    span.code && "rounded bg-muted px-1 py-px font-mono text-sm text-destructive-foreground",
    span.mention === "user" && "text-muted-foreground",
    notionColorClass(span.color),
  );
  const text = span.mention === "user" && !span.text.startsWith("@") ? `@${span.text}` : span.text;
  if (span.pageId !== undefined || span.href !== undefined) {
    return (
      <NotionLink
        href={span.href ?? `https://www.notion.so/${span.pageId?.replaceAll("-", "")}`}
        pageId={span.pageId}
        className={cn(className, span.mention === "page" && "font-medium")}
      >
        {text}
      </NotionLink>
    );
  }
  return className ? <span className={className}>{text}</span> : <>{text}</>;
}

export function NotionRichText({ spans }: { spans: ReadonlyArray<EsveoNotionSpan> }) {
  // oxlint-disable-next-line react/no-array-index-key -- spans have no ids and never reorder
  return spans.map((span, index) => <Span key={index} span={span} />);
}

export function NotionIcon({
  icon,
  className,
}: {
  icon: EsveoNotionIcon | null;
  className?: string;
}) {
  if (icon === null) return null;
  if (icon.kind === "emoji") return <span className={className}>{icon.emoji}</span>;
  return <img src={icon.url} alt="" className={cn("inline-block object-contain", className)} />;
}
