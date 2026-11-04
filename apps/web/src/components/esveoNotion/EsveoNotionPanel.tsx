import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ESVEO_NOTION_PAGE_REFS_MAX,
  type EsveoNotionError,
  type EsveoNotionFileUrlInput,
  type EsveoNotionPage,
  type EsveoNotionPageRef,
  notionPageUrl,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { type SVGProps, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";
import type { RightPanelSurface } from "~/rightPanelStore";
import { useAtomCommand } from "~/state/use-atom-command";
import { NotionBlocks } from "./EsveoNotionBlocks";
import { formatNotionDate, NotionPerson, NotionProperties } from "./EsveoNotionProperties";
import { NotionIcon, type NotionViewActions, NotionViewContext } from "./EsveoNotionRichText";
import { esveoNotionEnvironment } from "./esveoNotionState";
import {
  refKey,
  tabHistory,
  tabKey,
  updateNotionSurface,
  useEsveoNotionStore,
} from "./esveoNotionStore";

type NotionSurface = Extract<RightPanelSurface, { kind: "notion" }>;

type LoadState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly page: EsveoNotionPage }
  | {
      readonly _tag: "error";
      readonly error: Pick<
        EsveoNotionError,
        "reason" | "message" | "integrationName" | "retryAfterSeconds"
      >;
    };

const BREADCRUMB_SHOWN = 3;

export function EsveoNotionTabIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden {...props}>
      <rect x="2" y="1.5" width="12" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5.5 11V5l5 6V5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const asNotionError = (failure: unknown): LoadState & { _tag: "error" } => {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "EsveoNotionError"
  ) {
    return { _tag: "error", error: failure as EsveoNotionError };
  }
  return {
    _tag: "error",
    error: {
      reason: "unexpected",
      message: failure instanceof Error ? failure.message : "Notion ist nicht erreichbar.",
    },
  };
};

const relationIds = (page: EsveoNotionPage) =>
  page.properties.flatMap((property) =>
    property.value.kind === "relation" ? property.value.pageIds : [],
  );

const openExternal = (url: string) => {
  void readLocalApi()?.shell.openExternal(url);
};

/** Fork: a read-only Notion page in a right-panel tab. */
export function EsveoNotionPanel({
  threadRef,
  surface,
}: {
  threadRef: ScopedThreadRef | null;
  surface: NotionSurface;
}) {
  if (threadRef === null) return null;
  return <NotionTab key={surface.id} threadRef={threadRef} surface={surface} />;
}

function NotionTab({ threadRef, surface }: { threadRef: ScopedThreadRef; surface: NotionSurface }) {
  const environmentId = threadRef.environmentId;
  const pageId = surface.pageId;
  const key = tabKey(threadRef, surface.id);
  const storedHistory = useEsveoNotionStore((state) => state.historyByTab[key]);
  const history = tabHistory(storedHistory, pageId);
  const readPage = useAtomCommand(esveoNotionEnvironment.page, { reportFailure: false });
  const readRefs = useAtomCommand(esveoNotionEnvironment.pageRefs, { reportFailure: false });
  const readFileUrl = useAtomCommand(esveoNotionEnvironment.fileUrl, { reportFailure: false });
  const [request, setRequest] = useState({ refresh: false, nonce: 0 });
  const requestKey = `${pageId}:${request.nonce}`;
  const [loaded, setLoaded] = useState<{ key: string; state: LoadState } | null>(null);
  const load: LoadState = loaded?.key === requestKey ? loaded.state : { _tag: "loading" };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the page from the environment's server
  useEffect(() => {
    let cancelled = false;
    const setLoad = (state: LoadState) => setLoaded({ key: requestKey, state });
    void readPage({
      environmentId,
      input: request.refresh ? { pageId, refresh: true } : { pageId },
    }).then((result) => {
      if (cancelled || isAtomCommandInterrupted(result)) return;
      if (result._tag !== "Success") {
        setLoad(asNotionError(squashAtomCommandFailure(result)));
        return;
      }
      setLoad({ _tag: "ready", page: result.value });
      updateNotionSurface(threadRef, surface.id, { title: result.value.title });
      const known = useEsveoNotionStore.getState().refs;
      const missing = [...new Set(relationIds(result.value))].filter(
        (id) => known[refKey(environmentId, id)] === undefined,
      );
      for (let start = 0; start < missing.length; start += ESVEO_NOTION_PAGE_REFS_MAX) {
        void readRefs({
          environmentId,
          input: { pageIds: missing.slice(start, start + ESVEO_NOTION_PAGE_REFS_MAX) },
        }).then((refs) => {
          if (refs._tag === "Success") {
            useEsveoNotionStore.getState().addRefs(environmentId, refs.value);
          }
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, pageId, readPage, readRefs, request, requestKey, surface.id, threadRef]);

  const retryAfter =
    load._tag === "error" && load.error.reason === "rate_limited"
      ? (load.error.retryAfterSeconds ?? 1)
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retries after the wait Notion asked for
  useEffect(() => {
    if (retryAfter === null) return;
    const timer = window.setTimeout(
      () => setRequest((current) => ({ refresh: false, nonce: current.nonce + 1 })),
      retryAfter * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [retryAfter]);

  const goTo = (
    nextPageId: string,
    nextHistory: { entries: ReadonlyArray<string>; index: number },
  ) => {
    useEsveoNotionStore.getState().setHistory(key, nextHistory);
    updateNotionSurface(threadRef, surface.id, { pageId: nextPageId });
  };
  const navigate = (nextPageId: string) => {
    if (nextPageId === pageId) return;
    goTo(nextPageId, {
      entries: [...history.entries.slice(0, history.index + 1), nextPageId],
      index: history.index + 1,
    });
  };
  const step = (delta: -1 | 1) => {
    const index = history.index + delta;
    const target = history.entries[index];
    if (target !== undefined) goTo(target, { entries: history.entries, index });
  };
  const reload = () => setRequest((current) => ({ refresh: true, nonce: current.nonce + 1 }));

  const freshFileUrl = async (input: EsveoNotionFileUrlInput) => {
    const result = await readFileUrl({ environmentId, input });
    return result._tag === "Success" ? result.value.url : null;
  };
  const pageUrl = load._tag === "ready" ? load.page.url : notionPageUrl(pageId);
  const actions: NotionViewActions = {
    environmentId,
    pageId,
    pageUrl,
    navigate,
    freshFileUrl,
    openFile: (input, fallbackUrl) => {
      if (fallbackUrl !== undefined) {
        openExternal(fallbackUrl);
        return;
      }
      void freshFileUrl(input).then((url) => {
        if (url !== null) openExternal(url);
        else toastManager.add({ type: "error", title: "Die Datei ist nicht erreichbar." });
      });
    },
  };

  const copyLink = () => {
    void navigator.clipboard.writeText(pageUrl).then(
      () => toastManager.add({ type: "success", title: "Link kopiert" }),
      () => toastManager.add({ type: "error", title: "Link konnte nicht kopiert werden." }),
    );
  };

  return (
    <NotionViewContext.Provider value={actions}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-[38px] shrink-0 items-center gap-1 border-b px-2">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zurück"
            disabled={history.index === 0}
            onClick={() => step(-1)}
          >
            <ArrowLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Vorwärts"
            disabled={history.index >= history.entries.length - 1}
            onClick={() => step(1)}
          >
            <ArrowRightIcon />
          </Button>
          <div className="min-w-0 flex-1">
            {load._tag === "ready" && <Breadcrumb page={load.page} navigate={navigate} />}
          </div>
          <Button variant="ghost" size="icon-xs" aria-label="Link kopieren" onClick={copyLink}>
            <CopyIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Neu laden"
            disabled={load._tag === "loading"}
            onClick={reload}
          >
            <RefreshCwIcon />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            render={<a href={pageUrl} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
            In Notion öffnen
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {load._tag === "loading" && <StaticSkeleton />}
          {load._tag === "error" && <NotionErrorView error={load.error} reload={reload} />}
          {load._tag === "ready" && <NotionPageView page={load.page} />}
        </div>
      </div>
    </NotionViewContext.Provider>
  );
}

function Crumb({ crumb, navigate }: { crumb: EsveoNotionPageRef; navigate: (id: string) => void }) {
  const clickable = crumb.accessible && crumb.kind !== "workspace";
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => navigate(crumb.id)}
      className="inline-flex min-w-0 items-center gap-1 truncate rounded px-1 py-0.5 hover:bg-accent disabled:hover:bg-transparent"
    >
      <NotionIcon icon={crumb.icon} className="size-3.5 shrink-0 text-xs" />
      <span className="truncate">{crumb.title}</span>
    </button>
  );
}

function Breadcrumb({ page, navigate }: { page: EsveoNotionPage; navigate: (id: string) => void }) {
  const crumbs = page.breadcrumb;
  const cut = crumbs.length > BREADCRUMB_SHOWN;
  const shown = cut ? [crumbs[0]!, ...crumbs.slice(-(BREADCRUMB_SHOWN - 1))] : crumbs;
  const hiddenTitles = cut
    ? crumbs
        .slice(1, -(BREADCRUMB_SHOWN - 1))
        .map((crumb) => crumb.title)
        .join(" / ")
    : "";
  return (
    <nav aria-label="Pfad" className="flex min-w-0 items-center text-xs text-muted-foreground">
      {shown.map((crumb, index) => (
        <span key={crumb.id} className="flex min-w-0 items-center">
          {index > 0 && <span className="px-0.5">/</span>}
          {cut && index === 1 && (
            <>
              <span aria-label={hiddenTitles} className="px-1">
                …
              </span>
              <span className="px-0.5">/</span>
            </>
          )}
          <Crumb crumb={crumb} navigate={navigate} />
        </span>
      ))}
      {shown.length > 0 && <span className="px-0.5">/</span>}
      <span className="truncate px-1 text-foreground">{page.title}</span>
    </nav>
  );
}

function NotionPageView({ page }: { page: EsveoNotionPage }) {
  const parentDatabase =
    page.breadcrumb.at(-1)?.kind === "database" ? page.breadcrumb.at(-1) : null;
  const editedAt = formatNotionDate(page.lastEditedTime);
  return (
    <article className="mx-auto max-w-[720px] px-8 pt-8 pb-16 text-base leading-relaxed">
      {page.icon && (
        <NotionIcon icon={page.icon} className="mb-2 block size-12 text-5xl leading-none" />
      )}
      <h1 className="text-3xl leading-tight font-bold">{page.title || "Ohne Titel"}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
        {parentDatabase && (
          <>
            <span>in {parentDatabase.title}</span>
            <span>·</span>
          </>
        )}
        <span>Zuletzt bearbeitet {editedAt}</span>
        {/* A personal access token cannot look up other users; "von Unbekannt" says nothing. */}
        {page.lastEditedBy?.name && (
          <>
            <span>von</span>
            <NotionPerson user={page.lastEditedBy} />
          </>
        )}
      </div>
      {page.properties.length > 0 && (
        <div className="mt-5">
          <NotionProperties properties={page.properties} />
        </div>
      )}
      <hr className="my-5 border-border" />
      {page.kind === "database" ? (
        <p className="text-sm text-muted-foreground">
          Datenbank-Ansichten zeigt esveo code nicht an ·{" "}
          <a href={page.url} target="_blank" rel="noreferrer" className="underline">
            in Notion öffnen
          </a>
        </p>
      ) : (
        <NotionBlocks blocks={page.blocks} />
      )}
      {page.truncated && (
        <p className="mt-6 text-sm text-muted-foreground">
          Die Seite ist zu lang und wird hier gekürzt ·{" "}
          <a href={page.url} target="_blank" rel="noreferrer" className="underline">
            in Notion weiterlesen
          </a>
        </p>
      )}
    </article>
  );
}

const SKELETON_WIDTHS = ["w-11/12", "w-10/12", "w-full", "w-8/12", "w-9/12", "w-7/12"];

/** Grey bars without animation: a pulsing skeleton repaints every frame. */
function StaticSkeleton() {
  return (
    <div aria-busy aria-label="Lädt" className="mx-auto max-w-[720px] px-8 pt-8">
      <div className="mb-3 size-12 rounded-md bg-muted" />
      <div className="mb-3 h-8 w-2/3 rounded bg-muted" />
      <div className="mb-8 h-4 w-1/3 rounded bg-muted/70" />
      {SKELETON_WIDTHS.map((width) => (
        <div key={width} className={`mb-3 h-4 rounded bg-muted/70 ${width}`} />
      ))}
    </div>
  );
}

function NotionErrorView({
  error,
  reload,
}: {
  error: (LoadState & { _tag: "error" })["error"];
  reload: () => void;
}) {
  const reloadButton = (
    <Button variant="outline" size="sm" onClick={reload}>
      <RefreshCwIcon />
      Neu laden
    </Button>
  );
  const body = (() => {
    switch (error.reason) {
      case "not_shared": {
        const name = error.integrationName ?? "die esveo-code-Integration";
        return (
          <>
            <h2 className="font-semibold">Diese Seite ist für esveo code nicht freigegeben</h2>
            <p className="text-muted-foreground">
              Die Integration „{name}“ kann sie nicht lesen. Gib die Seite in Notion frei:
            </p>
            <ol className="list-decimal pl-5 text-muted-foreground">
              <li>Seite in Notion öffnen</li>
              <li>••• → Connections → „{name}“ hinzufügen</li>
              <li>Hier neu laden</li>
            </ol>
            {reloadButton}
          </>
        );
      }
      case "unauthorized":
      case "not_connected":
        return (
          <>
            <h2 className="font-semibold">
              {error.reason === "not_connected"
                ? "Notion ist nicht verbunden"
                : "Notion lehnt das Secret ab"}
            </h2>
            <p className="text-muted-foreground">
              Verbinde eine Notion-Integration in den{" "}
              <Link to="/settings/source-control" className="underline">
                Einstellungen
              </Link>
              .
            </p>
          </>
        );
      case "rate_limited":
        return (
          <>
            <h2 className="font-semibold">Notion bremst gerade</h2>
            <p className="text-muted-foreground">
              Neuer Versuch in {error.retryAfterSeconds ?? 1} Sekunden.
            </p>
          </>
        );
      case "invalid_id":
        return (
          <>
            <h2 className="font-semibold">Kein gültiger Notion-Link</h2>
            <p className="text-muted-foreground">{error.message}</p>
          </>
        );
      case "network":
      case "unexpected":
        return (
          <>
            <h2 className="font-semibold">Notion ist nicht erreichbar</h2>
            <p className="text-muted-foreground">{error.message}</p>
            {reloadButton}
          </>
        );
    }
  })();
  return (
    <div className="mx-auto flex max-w-[520px] flex-col items-start gap-3 px-8 pt-12 text-sm">
      {body}
    </div>
  );
}
