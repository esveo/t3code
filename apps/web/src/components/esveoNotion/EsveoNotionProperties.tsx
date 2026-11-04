import type {
  EsveoNotionDate,
  EsveoNotionOption,
  EsveoNotionProperty,
  EsveoNotionScalarValue,
  EsveoNotionPropertyValue,
  EsveoNotionUser,
} from "@t3tools/contracts";
import { CheckSquareIcon, FileIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { NotionIcon, NotionLink, NotionRichText, useNotionView } from "./EsveoNotionRichText";
import { optionColorClass, statusDotClass } from "./notionColors";
import { refKey, useEsveoNotionStore } from "./esveoNotionStore";

const RELATIONS_SHOWN = 5;

const dateFormat = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" });
const dateTimeFormat = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatNotionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return (value.includes("T") ? dateTimeFormat : dateFormat).format(date);
}

const formatRange = (date: EsveoNotionDate) =>
  date.end === null
    ? formatNotionDate(date.start)
    : `${formatNotionDate(date.start)} → ${formatNotionDate(date.end)}`;

function OptionChip({ option, status }: { option: EsveoNotionOption; status?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 truncate rounded-sm px-1.5 py-px text-sm leading-5",
        optionColorClass(option.color),
        status && "rounded-full px-2",
      )}
    >
      {status && (
        <span className={cn("size-2 shrink-0 rounded-full", statusDotClass(option.color))} />
      )}
      {option.name}
    </span>
  );
}

export function NotionPerson({ user }: { user: EsveoNotionUser }) {
  const name = user.name ?? "Unbekannt";
  return (
    <span className="inline-flex items-center gap-1.5">
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="size-5 rounded-full object-cover" />
      ) : (
        <span className="flex size-5 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground">
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      {name}
    </span>
  );
}

function Relation({ pageIds, hasMore }: { pageIds: ReadonlyArray<string>; hasMore: boolean }) {
  const { environmentId, navigate } = useNotionView();
  const [expanded, setExpanded] = useState(false);
  const refs = useEsveoNotionStore((state) => state.refs);
  const shown = expanded ? pageIds : pageIds.slice(0, RELATIONS_SHOWN);
  const hidden = pageIds.length - shown.length;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((pageId) => {
        const ref = refs[refKey(environmentId, pageId)];
        return (
          <button
            key={pageId}
            type="button"
            onClick={() => navigate(pageId)}
            disabled={ref?.accessible === false}
            className="inline-flex max-w-full items-center gap-1 truncate rounded-sm px-1 text-left underline decoration-foreground/25 underline-offset-2 hover:bg-accent disabled:text-muted-foreground disabled:no-underline"
          >
            {ref === undefined ? (
              <span className="text-muted-foreground">Lädt …</span>
            ) : (
              <>
                <NotionIcon icon={ref.icon} className="size-4 text-sm" />
                {ref.title}
              </>
            )}
          </button>
        );
      })}
      {(hidden > 0 || hasMore) && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-sm px-1 text-muted-foreground hover:bg-accent"
        >
          {hidden > 0 ? `+ ${hidden} weitere` : "+ weitere in Notion"}
        </button>
      )}
    </span>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => (
  <span className="text-muted-foreground">{children}</span>
);

function Scalar({
  value,
  property,
}: {
  value: EsveoNotionScalarValue;
  property: EsveoNotionProperty;
}) {
  const { openFile, pageId } = useNotionView();
  switch (value.kind) {
    case "rich_text":
      return <NotionRichText spans={value.spans} />;
    case "text":
      return <>{value.text}</>;
    case "number":
      return <>{value.number === null ? "" : value.number.toLocaleString("de-DE")}</>;
    case "select":
      return value.option && <OptionChip option={value.option} />;
    case "status":
      return value.option && <OptionChip option={value.option} status />;
    case "multi_select":
      return (
        <span className="flex flex-wrap gap-1">
          {value.options.map((option) => (
            <OptionChip key={option.name} option={option} />
          ))}
        </span>
      );
    case "date":
      return <>{value.date && formatRange(value.date)}</>;
    case "people":
      return (
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {value.people.map((user) => (
            <NotionPerson key={user.id} user={user} />
          ))}
        </span>
      );
    case "checkbox":
      return value.checked ? (
        <CheckSquareIcon aria-label="Ja" className="size-4 text-info" />
      ) : (
        <SquareIcon aria-label="Nein" className="size-4 text-muted-foreground" />
      );
    case "url":
      return value.value && <NotionLink href={value.value}>{value.value}</NotionLink>;
    case "email":
      return value.value && <a href={`mailto:${value.value}`}>{value.value}</a>;
    case "phone":
      return value.value && <a href={`tel:${value.value}`}>{value.value}</a>;
    case "relation":
      return <Relation pageIds={value.pageIds} hasMore={value.hasMore} />;
    case "files":
      return (
        <span className="flex flex-col items-start gap-0.5">
          {value.files.map((file, index) => (
            <button
              // oxlint-disable-next-line react/no-array-index-key -- the index is the file's address in Notion
              key={index}
              type="button"
              onClick={() => openFile({ pageId, propertyId: property.id, index }, file.url)}
              className="inline-flex items-center gap-1 rounded-sm px-1 hover:bg-accent"
            >
              <FileIcon className="size-3.5 text-muted-foreground" />
              {file.name}
            </button>
          ))}
        </span>
      );
    case "unsupported":
      return <Muted>Nicht unterstützt ({property.type})</Muted>;
  }
}

function PropertyValue({ property }: { property: EsveoNotionProperty }) {
  const value: EsveoNotionPropertyValue = property.value;
  if (property.empty) return <Muted>Leer</Muted>;
  if (value.kind !== "rollup") return <Scalar value={value} property={property} />;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {value.items.map((item, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- rollup items have no ids
        <Scalar key={index} value={item} property={property} />
      ))}
    </span>
  );
}

function PropertyRow({ property }: { property: EsveoNotionProperty }) {
  return (
    <>
      <div className="truncate py-1 text-muted-foreground">{property.name}</div>
      <div className="min-w-0 py-1 break-words">
        <PropertyValue property={property} />
      </div>
    </>
  );
}

/** Filled properties, then the empty ones behind a toggle. */
export function NotionProperties({
  properties,
}: {
  properties: ReadonlyArray<EsveoNotionProperty>;
}) {
  const [showEmpty, setShowEmpty] = useState(false);
  const filled = properties.filter((property) => !property.empty);
  const empty = properties.filter((property) => property.empty);
  if (properties.length === 0) return null;
  return (
    <div className="text-sm">
      <div className="grid grid-cols-[minmax(96px,160px)_minmax(0,1fr)] gap-x-3">
        {filled.map((property) => (
          <PropertyRow key={property.id} property={property} />
        ))}
        {showEmpty &&
          empty.map((property) => <PropertyRow key={property.id} property={property} />)}
      </div>
      {empty.length > 0 && (
        <button
          type="button"
          onClick={() => setShowEmpty((open) => !open)}
          className="mt-1 rounded-sm px-1 py-0.5 text-muted-foreground hover:bg-accent"
        >
          {showEmpty
            ? "Leere Properties ausblenden"
            : `${empty.length} leere ${empty.length === 1 ? "Property" : "Properties"} anzeigen`}
        </button>
      )}
    </div>
  );
}
