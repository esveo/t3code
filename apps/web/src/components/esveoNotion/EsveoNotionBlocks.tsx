import { type EsveoNotionBlock, notionPageUrl } from "@t3tools/contracts";
import {
  CheckSquareIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FileIcon,
  FileTextIcon,
  LinkIcon,
  SquareIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { NotionIcon, NotionLink, NotionRichText, useNotionView } from "./EsveoNotionRichText";
import { notionColorClass } from "./notionColors";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function Children({ block }: { block: EsveoNotionBlock }) {
  if (block.children === undefined) return null;
  return (
    <div className="pl-6">
      <NotionBlocks blocks={block.children} />
    </div>
  );
}

function Text({ block }: { block: EsveoNotionBlock }) {
  return <NotionRichText spans={block.spans ?? []} />;
}

function Toggle({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex items-start gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Zuklappen" : "Aufklappen"}
          onClick={() => setOpen((value) => !value)}
          className="mt-[3px] flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent"
        >
          <ChevronRightIcon className={cn("size-4", open && "rotate-90")} />
        </button>
        <div className="min-w-0 flex-1">{summary}</div>
      </div>
      {open && children}
    </div>
  );
}

const HEADING_CLASS = {
  heading_1: "mt-6 mb-1 text-[1.6em] font-semibold leading-tight",
  heading_2: "mt-5 mb-1 text-[1.3em] font-semibold leading-tight",
  heading_3: "mt-4 mb-1 text-[1.1em] font-semibold leading-snug",
} as const;

function Row({
  icon,
  children,
  onClick,
  href,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  href?: string;
}) {
  const className =
    "my-0.5 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent";
  if (href !== undefined) {
    return (
      <NotionLink href={href} className={cn(className, "no-underline")}>
        {icon}
        <span className="min-w-0 truncate">{children}</span>
      </NotionLink>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

function NotionImage({ block }: { block: EsveoNotionBlock }) {
  const { freshFileUrl } = useNotionView();
  const [src, setSrc] = useState(block.url);
  const [retried, setRetried] = useState(false);
  if (src === undefined) return <Unsupported block={block} />;
  const onError = () => {
    // Notion's signed URLs expire after about an hour; ask the server for a fresh one once.
    if (!block.hosted || retried) return;
    setRetried(true);
    void freshFileUrl({ blockId: block.id }).then((url) => {
      if (url !== null) setSrc(url);
    });
  };
  return (
    <figure className="my-2">
      <img src={src} alt="" onError={onError} className="max-w-full rounded-sm" loading="lazy" />
      {block.caption && (
        <figcaption className="mt-1 text-sm text-muted-foreground">
          <NotionRichText spans={block.caption} />
        </figcaption>
      )}
    </figure>
  );
}

function Unsupported({ block }: { block: EsveoNotionBlock }) {
  const { pageUrl } = useNotionView();
  return (
    <div className="my-1 rounded-md border border-dashed px-2 py-1.5 text-sm text-muted-foreground">
      Block „{block.notionType ?? block.type}“ wird hier nicht angezeigt ·{" "}
      <a href={pageUrl} target="_blank" rel="noreferrer" className="underline">
        In Notion öffnen
      </a>
    </div>
  );
}

function Table({ block }: { block: EsveoNotionBlock }) {
  const rows = block.children ?? [];
  return (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.id}>
              {(row.cells ?? []).map((cell, cellIndex) => {
                const header =
                  (block.columnHeader === true && rowIndex === 0) ||
                  (block.rowHeader === true && cellIndex === 0);
                const Cell = header ? "th" : "td";
                return (
                  <Cell
                    // oxlint-disable-next-line react/no-array-index-key -- cells are positional
                    key={cellIndex}
                    className={cn(
                      "border px-2 py-1 text-left align-top",
                      header && "bg-muted/50 font-medium",
                    )}
                  >
                    <NotionRichText spans={cell} />
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Block({ block }: { block: EsveoNotionBlock }) {
  const { navigate, openFile } = useNotionView();
  const color = notionColorClass(block.color);
  switch (block.type) {
    case "paragraph":
      return (
        <div className={cn("my-px min-h-6 py-0.5 whitespace-pre-wrap", color)}>
          <Text block={block} />
          <Children block={block} />
        </div>
      );
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const heading = (
        <div className={cn(HEADING_CLASS[block.type], color)}>
          <Text block={block} />
        </div>
      );
      if (block.toggleable !== true) return heading;
      return (
        <Toggle summary={heading}>
          <Children block={block} />
        </Toggle>
      );
    }
    case "to_do":
      return (
        <div className={cn("my-px", color)}>
          <div className="flex items-start gap-2 py-0.5">
            {block.checked ? (
              <CheckSquareIcon className="mt-0.5 size-4 shrink-0 text-info" />
            ) : (
              <SquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <span className={cn(block.checked && "text-muted-foreground line-through")}>
              <Text block={block} />
            </span>
          </div>
          <Children block={block} />
        </div>
      );
    case "toggle":
      return (
        <div className={cn("my-px py-0.5", color)}>
          <Toggle summary={<Text block={block} />}>
            <Children block={block} />
          </Toggle>
        </div>
      );
    case "callout":
      return (
        <div
          className={cn(
            "my-1 flex gap-2.5 rounded-md px-3 py-2.5",
            color || "bg-muted/60",
            block.color === undefined && "border",
          )}
        >
          <NotionIcon icon={block.icon ?? null} className="size-5 shrink-0 text-lg leading-6" />
          <div className="min-w-0 flex-1 whitespace-pre-wrap">
            <Text block={block} />
            {block.children && <NotionBlocks blocks={block.children} />}
          </div>
        </div>
      );
    case "quote":
      return (
        <blockquote className={cn("my-1 border-l-4 border-foreground px-3.5 py-0.5", color)}>
          <Text block={block} />
          {block.children && <NotionBlocks blocks={block.children} />}
        </blockquote>
      );
    case "code":
      return (
        <figure className="my-2">
          <div className="rounded-md bg-muted/60 px-4 py-3">
            <div className="mb-1 text-xs text-muted-foreground">{block.language}</div>
            <pre className="overflow-x-auto font-mono text-sm leading-relaxed">
              <code>{(block.spans ?? []).map((span) => span.text).join("")}</code>
            </pre>
          </div>
          {block.caption && (
            <figcaption className="mt-1 text-sm text-muted-foreground">
              <NotionRichText spans={block.caption} />
            </figcaption>
          )}
        </figure>
      );
    case "divider":
      return <hr className="my-3 border-border" />;
    case "equation":
      return (
        <div className="my-1 overflow-x-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-sm">
          {block.expression}
        </div>
      );
    case "image":
      return <NotionImage block={block} />;
    case "file":
      return (
        <Row
          icon={<FileIcon className="size-4 shrink-0 text-muted-foreground" />}
          onClick={() => openFile({ blockId: block.id }, block.hosted ? undefined : block.url)}
        >
          {block.name ?? block.notionType}
        </Row>
      );
    case "bookmark":
      return block.url === undefined ? (
        <Unsupported block={block} />
      ) : (
        <Row icon={<LinkIcon className="size-4 shrink-0 text-muted-foreground" />} href={block.url}>
          {block.caption ? <NotionRichText spans={block.caption} /> : hostOf(block.url)}
          <span className="ml-2 text-muted-foreground">{block.url}</span>
        </Row>
      );
    case "page":
      return block.pageId === undefined ? null : (
        <Row
          icon={<FileTextIcon className="size-4 shrink-0 text-muted-foreground" />}
          onClick={() => navigate(block.pageId!)}
        >
          <span className="underline decoration-foreground/25 underline-offset-2">
            {block.title ?? "Verknüpfte Seite"}
          </span>
        </Row>
      );
    case "database":
      return block.pageId === undefined ? null : (
        <div className="my-2 flex items-center gap-2 rounded-md border px-3 py-2.5 text-sm">
          <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium">{block.title ?? "Datenbank"}</span>
          <span className="text-muted-foreground">
            Datenbank-Ansicht ·{" "}
            <a
              href={notionPageUrl(block.pageId)}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              in Notion öffnen
            </a>
          </span>
        </div>
      );
    case "table":
      return <Table block={block} />;
    case "column_list":
      return (
        <div className="my-1 flex flex-col gap-4 sm:flex-row">
          {(block.children ?? []).map((column) => (
            <div key={column.id} className="min-w-0 flex-1">
              <NotionBlocks blocks={column.children ?? []} />
            </div>
          ))}
        </div>
      );
    case "column":
    case "synced_block":
      return <NotionBlocks blocks={block.children ?? []} />;
    case "bulleted_list_item":
    case "numbered_list_item":
    case "table_row":
      // Lists are rendered by NotionBlocks; a lone row has no table.
      return null;
    case "unsupported":
      return <Unsupported block={block} />;
  }
}

type ListType = "bulleted_list_item" | "numbered_list_item";

/** Blocks in order, with runs of list items gathered into one list. */
export function NotionBlocks({ blocks }: { blocks: ReadonlyArray<EsveoNotionBlock> }) {
  const groups: Array<{ list: ListType | null; blocks: EsveoNotionBlock[] }> = [];
  for (const block of blocks) {
    const list =
      block.type === "bulleted_list_item" || block.type === "numbered_list_item"
        ? block.type
        : null;
    const last = groups.at(-1);
    if (list !== null && last?.list === list) last.blocks.push(block);
    else groups.push({ list, blocks: [block] });
  }
  return groups.map((group) => {
    const first = group.blocks[0]!;
    if (group.list === null) return <Block key={first.id} block={first} />;
    const List = group.list === "numbered_list_item" ? "ol" : "ul";
    return (
      <List
        key={first.id}
        className={cn("my-px pl-6", List === "ol" ? "list-decimal" : "list-disc")}
      >
        {group.blocks.map((item) => (
          <li key={item.id} className={cn("py-0.5 pl-1", notionColorClass(item.color))}>
            <span className="whitespace-pre-wrap">
              <Text block={item} />
            </span>
            {item.children && <NotionBlocks blocks={item.children} />}
          </li>
        ))}
      </List>
    );
  });
}
