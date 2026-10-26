import { buildFileLinkParentSuffixByPath, fileLinkLabel } from "@t3tools/shared/fileLinks";
import {
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
} from "@t3tools/shared/markdownLinks";
import { isHostPath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  SOURCE_CONTROL_MEDIA_ASSET,
} from "@t3tools/contracts";
// Fork: orchestration's own `t3-thread:<id>` links render as live chips.
import { parseThreadLinkHref as parseForkThreadLinkHref } from "@t3tools/shared/threadOrchestration";
import { ThreadLinkChip } from "./threadOrchestration/ThreadLinkChip";
import { pullRequestMediaResource } from "./pullRequest/pullRequestMediaResource";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { useAtomValue } from "@effect/atom-react";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  FileSpreadsheetIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  LightbulbIcon,
  MailIcon,
  MessageSquareIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  PresentationIcon,
  SparklesIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import {
  AssetWorkspaceAssetNotFoundError,
  AuthPreviewOperateScope,
  type EditorId,
  type EnvironmentId,
  type ServerConfig,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
  type CodexArtifactTemplateKind,
} from "@t3tools/shared/codexArtifactTemplates";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { mediaKindFromPath, mediaMimeTypeFromExtension } from "@t3tools/shared/mediaPreview";
import { InlineAudioPreview } from "./files/InlineAudioPreview";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import React, {
  Suspense,
  type ComponentProps,
  type ClipboardEvent as ReactClipboardEvent,
  use,
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Components,
  ExtraProps as ReactMarkdownExtraProps,
  Options as ReactMarkdownOptions,
} from "react-markdown";
import ReactMarkdown from "react-markdown";
import { createIncrementalMarkdownPlugin } from "../markdown-incremental";
import { defaultUrlTransform } from "react-markdown";
import { parseAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { AssistantCitationChip } from "./chat/AssistantCitationChip";
import { MarkdownThreadLink } from "./chat/MarkdownThreadLink";
import { mathKind } from "@t3tools/shared/markdownMath";
import remarkMath from "remark-math";
import {
  artifactTemplateFromHastProperties,
  renderCodexInlineDirectivesAsMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import { MarkdownMath } from "./chat/MarkdownMath";
import {
  resolveMarkdownMediaPreview,
  type ExpandedImagePreview,
} from "./chat/ExpandedImagePreview";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { markdownImageGallery } from "./chat/markdownImageGallery";
import { type MediaActionSource } from "./media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "./media/mediaContent";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "./preview/fileExplorerLabel";
import {
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from "./chat/externalLinkContextMenu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { recordVisitForThread } from "../browserHistoryStore";
import {
  PreferredEditorEnvironmentRequiredError,
  useOpenInPreferredEditor,
  usePreferredEditor,
} from "../editorPreferences";
import { openInEditorMenuLabel } from "../editorLabels";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { useRenderedAppearance } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "../markdownFileHostPath";
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { resolveRemoteOpenState, useRemoteOpenResolution } from "../remoteOpen";
import { useRightPanelStore } from "../rightPanelStore";
import { readThreadShell, useProjects } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import { assetEnvironment } from "../state/assets";
import {
  readEnvironmentScope,
  readPreparedConnection,
  useEnvironmentScope,
} from "../state/session";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { projectEnvironment } from "../state/projects";
import { filesystemEnvironment } from "../state/filesystem";
import {
  needsNestedRepoFileLookup,
  useNestedRepoFileLinkResolver,
} from "./nestedRepoFileLinks/useNestedRepoFileLinkResolver";
import {
  claimWorkspaceBasenameLookup,
  needsWorkspaceBasenameLookup,
  pickStrippedWorkspaceMatch,
  pickWorkspaceBasenameMatch,
  stripRepeatedWorkspacePrefix,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import { resolvePullRequestPreviewTarget } from "@t3tools/client-runtime/change-request-links";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { useOpenLink } from "../browser/useOpenLink";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import {
  isBrowserPreviewFile,
  openFileInPreview,
  openUrlInPreview,
  BrowserPreviewUnavailableError,
  BrowserSettingsReadError,
} from "../browser/openFileInPreview";
import { resolveLinkTarget } from "../browser/browserLinkTarget";
import { PullRequestLinkPreview } from "./pullRequest/PullRequestLinkPreview";
import { MarkdownCodeBlock, SuspenseShikiCodeBlock } from "./chat/MarkdownCodeBlock";
import { MarkdownMermaidCodeBlock } from "./chat/MarkdownMermaidCodeBlock";
import { MarkdownTable } from "./chat/MarkdownTable";
import { MarkdownDetails } from "./chat/MarkdownDetails";
import {
  authoredImageSizeStyle,
  ChatMarkdownAssetImage,
  ChatMarkdownImage,
  ChatMarkdownImageFallback,
  ChatMarkdownVideo,
  MarkdownLinkContext,
  markdownImageCopy,
} from "./chat/ChatMarkdownMedia";
import { MarkdownExternalLinkContent } from "./chat/MarkdownExternalLink";
import { MarkdownFileLink } from "./chat/MarkdownFileLink";
import { canUseMarkdownFileShellActions } from "./chat/MarkdownFileLink.logic";
import { handleMarkdownFragmentClick, rehypeHeadingIds } from "./chat/markdownFragments";
import { rehypeTextDirection } from "./chat/markdownTextDirection";
import { hastHasText, hastPlainTextDeep, plainHastText } from "./chat/markdownHast.logic";
import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  isClosedCodeFence,
  nodeToPlainText,
} from "./chat/MarkdownCodeBlock.logic";
import { reportMarkdownActionFailure } from "./chat/markdownActionFailure";

const isAssetNotFoundError = Schema.is(AssetWorkspaceAssetNotFoundError);

interface ChatMarkdownProps {
  /** Compact markdown transforms remove blocks before rendering inside a label. */
  inline?: boolean;
  text: string;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  pullRequestPanelRef?: ScopedThreadRef | undefined;
  environmentId?: EnvironmentId | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  className?: string;
  lineBreaks?: boolean;
  parseRawHtml?: boolean;
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  onRunShellCommand?: ((command: string) => void) | undefined;
  imageBaseDir?: string | undefined;
  workspaceMutationId?: string | null | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  extraRemarkPlugins?: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  /** Loads media a source control host keeps behind a credential through the server, which holds
      `cwd`'s; without it a private repository's uploads load unauthenticated and 404. */
  sourceControlMedia?: boolean | undefined;
  headingLevelOffset?: number | undefined;
}

export interface ChatMarkdownContextReference {
  kind: string;
  contextId: string;
  label: string;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [];

const ARTIFACT_TEMPLATE_ICON_BY_KIND = {
  document: FileTextIcon,
  presentation: PresentationIcon,
  spreadsheet: FileSpreadsheetIcon,
  site: GlobeIcon,
  "google-docs": FileTextIcon,
  "google-slides": PresentationIcon,
  "google-sheets": FileSpreadsheetIcon,
  image: ImageIcon,
  email: MailIcon,
  slack: MessageSquareIcon,
} satisfies Record<CodexArtifactTemplateKind, LucideIcon>;

function CodexArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
}) {
  const Icon = ARTIFACT_TEMPLATE_ICON_BY_KIND[props.template.artifactKind];
  const presentationLabel = codexArtifactTemplatePresentationLabel(props.template.artifactKind);

  return (
    <div
      role="group"
      aria-label={`${props.template.displayName} template`}
      data-chat-markdown-artifact-template
      className="my-[0.65rem] flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-foreground shadow-xs"
      data-artifact-kind={props.template.artifactKind}
      data-markdown-copy={`${props.template.displayName} (${presentationLabel})\n\n`}
      data-skill-name={props.template.skillName}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground shadow-xs">
          <Icon aria-hidden className="size-5" />
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-background bg-primary text-primary-foreground shadow-xs">
            <SparklesIcon aria-hidden className="size-2.5" />
          </span>
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {props.template.displayName}
          </div>
          <div className="text-xs text-muted-foreground">{presentationLabel}</div>
        </div>
      </div>
      {props.onUse ? (
        <Button
          data-thread-find-ignore
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => props.onUse?.(props.template)}
        >
          Use template
        </Button>
      ) : null}
    </div>
  );
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;

interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
  readonly format?: "markdown" | "csv";
  readonly language?: string;
  readonly fenceTitle?: string;
  readonly copyTarget?: string;
}


const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

function orderedListGutterStyle(
  itemCount: number,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` };
}

const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
> = {
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-blue-600 dark:text-blue-400",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-red-500/70",
    titleClassName: "text-red-600 dark:text-red-400",
  },
};


const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;





| null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode; node?: { tagName?: string } }>(
      onlyChild,
    )
  ) {
    return null;
  }
  // With a custom `code` component the child's type is that component, not
  // the "code" tag — the hast node react-markdown attaches still names it.
  if (onlyChild.type !== "code" && onlyChild.props.node?.tagName !== "code") {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function readInitialWordWrapSetting(): boolean {
  return getClientSettings().wordWrap;
}

/**
 * Whether any cell is clipped in the unwrapped layout. Only then does the wrap
 * toggle change anything, so short tables hide it. Measures with the container
 * briefly unwrapped and restores it before the browser paints.
 */
function tableHasClippedCells(container: HTMLElement, table: HTMLTableElement): boolean {
  const viewport = table.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  const scrollLeft = viewport?.scrollLeft ?? 0;
  const previous = container.dataset.expanded;
  container.dataset.expanded = "false";
  try {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (cell.scrollWidth > cell.clientWidth) return true;
      }
    }
    return false;
  } finally {
    if (previous === undefined) delete container.dataset.expanded;
    else container.dataset.expanded = previous;
    // The unwrapped layout can be narrower and clamp a sideways scroll.
    if (viewport && scrollLeft > 0) viewport.scrollLeft = scrollLeft;
  }
}

: React.ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [expanded, setExpanded] = useState(readInitialWordWrapSetting);
  const [hasClippedCells, setHasClippedCells] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";
  const copyLabel = copied ? "Copied" : "Copy table";

  const measureClippedCells = () => {
    const container = containerRef.current;
    const table = tableRef.current;
    if (!container || !table) return;
    setHasClippedCells(tableHasClippedCells(container, table));
  };

  // A streamed cell can grow until it clips while the table keeps its size,
  // so remeasure after every render, not only on resize.
  useLayoutEffect(measureClippedCells);

  // Column width changes can clip a cell without rendering this table.
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    return observeResize(table, measureClippedCells);
  }, [measureClippedCells]);

  function toggleExpanded() {
    const table = tableRef.current;
    if (!table) return;

    if (!expanded) {
      const rows = [...table.rows];
      const columnWidths = rows.reduce<number[]>((widths, row) => {
        [...row.cells].forEach((cell, columnIndex) => {
          widths[columnIndex] = Math.max(
            widths[columnIndex] ?? 0,
            cell.getBoundingClientRect().width,
          );
        });
        return widths;
      }, []);

      [...(table.tHead?.rows[0]?.cells ?? [])].forEach((cell, columnIndex) => {
        cell.style.minWidth = `${columnWidths[columnIndex] ?? cell.getBoundingClientRect().width}px`;
      });
    }

    setExpanded((value) => !value);
  }

  const handleCopy = (format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table || typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    const text =
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure({ operation: "copy-table", format }, cause);
      });
  };

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="chat-markdown-table-container"
      data-expanded={expanded ? "true" : "false"}
    >
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        <table ref={tableRef} {...props}>
          {children}
        </table>
      </ScrollArea>
      <div className="mt-0.5 flex items-center justify-between select-none">
        {hasClippedCells ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={expanded ? "secondary" : "ghost-muted"}
                  size="icon-xs"
                  aria-pressed={expanded}
                  onClick={toggleExpanded}
                  aria-label={expandLabel}
                />
              }
            >
              <MorphIcon className="size-3" icon={expanded ? Minimize2 : Maximize2} />
            </TooltipTrigger>
            <TooltipPopup side="top">{expandLabel}</TooltipPopup>
          </Tooltip>
        ) : (
          <span />
        )}
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              <MorphIcon className="size-3" icon={copied ? Check : Copy} />
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

: Pick<React.ComponentProps<"details">, "children" | "open">) {
  const [isOpen, setIsOpen] = useState(open);
  const searching = use(MarkdownFindContext);
  const expanded = isOpen;
  const revealForFind = () => setIsOpen(true);
  // Base UI only listens for `beforematch` on a panel mounted at its first
  // render; a closed panel mounts later, when find starts, so listen here.
  const revealRef = findRevealRef(revealForFind);
  const childNodes = Children.toArray(children);
  const summaryIndex = childNodes.findIndex(
    (child) => isValidElement(child) && child.type === "summary",
  );
  const summaryNode = summaryIndex >= 0 ? childNodes[summaryIndex] : null;
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) && summaryNode.props.children
      ? summaryNode.props.children
      : "Details";
  const content = childNodes.filter((_, index) => index !== summaryIndex);

  return (
    <div className="my-2 border-y border-border/60">
      <Collapsible
        open={expanded}
        onOpenChange={setIsOpen}
        data-markdown-details=""
        data-markdown-details-open={expanded ? "true" : "false"}
      >
        <CollapsibleTrigger
          className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground data-panel-open:[&_svg]:rotate-90"
          data-markdown-details-summary=""
        >
          <ChevronRightIcon
            className="size-4 shrink-0 text-muted-foreground transition-transform"
            aria-hidden
          />
          <span>{summary}</span>
        </CollapsibleTrigger>
        <CollapsiblePanel ref={revealRef} hiddenUntilFound={searching}>
          <div
            className="pb-3 ps-6 text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)]"
            data-markdown-details-content=""
          >
            {content}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

const THREAD_FIND_IGNORE_PROPS = {
  "data-thread-find-ignore": "",
} as React.HTMLAttributes<HTMLDivElement>;

export function MarkdownCodeBlockFrame({
  as: Wrapper = "div",
  language,
  fenceTitle,
  theme,
  wrapped = true,
  title,
  actions,
  headerProps,
  children,
}: {
  as?: React.ElementType;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  wrapped?: boolean;
  title?: React.ReactNode;
  actions?: React.ReactNode;
  headerProps?: React.HTMLAttributes<HTMLDivElement>;
  children: React.ReactNode;
}) {
  return (
    <Wrapper
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-lg border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div
        {...headerProps}
        className={cn(
          "chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none",
          headerProps?.className,
        )}
      >
        {title ?? (
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs">
            <MarkdownCodeBlockTitleContent
              fenceTitle={fenceTitle}
              language={language}
              theme={theme}
            />
          </span>
        )}
        {actions}
      </div>
      {children}
    </Wrapper>
  );
}

function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
  theme,
}: {
  fenceTitle: string | null;
  language: string;
  theme: "light" | "dark";
}) {
  if (fenceTitle) {
    return (
      <>
        <PierreEntryIcon pathValue={fenceTitle} kind="file" theme={theme} className="size-3.5" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }

  const fileName = syntheticFileNameForLanguageId(language);
  if (!hasSpecificPierreIconForFileName(fileName)) {
    return <span className="truncate">{language}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 rounded-sm" aria-label={`Language: ${language}`} />
        }
      >
        <PierreEntryIcon pathValue={fileName} kind="file" theme={theme} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{language}</TooltipPopup>
    </Tooltip>
  );
}

: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  onRunShellCommand?: ((command: string) => void) | undefined;
  isStreaming: boolean;
  viewToggle?: ReactNode;
  canWrap?: boolean;
  diagram?: boolean;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(readInitialWordWrapSetting);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";
  const command = code.trim();
  const canRun =
    onRunShellCommand !== undefined &&
    !isStreaming &&
    /^(?:sh|bash|zsh|fish|shell|powershell|pwsh)$/.test(language) &&
    code.endsWith("\n") &&
    command.length > 0 &&
    !command.endsWith("\\") &&
    // Control and invisible format characters (bidi overrides, zero-width) can
    // make the rendered command differ from what the terminal would receive.
    !/[\p{Cc}\p{Cf}]/u.test(code.slice(0, -1));

  const handleCopy = () => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure(
          {
            operation: "copy-code-block",
            language,
            ...(fenceTitle ? { fenceTitle } : {}),
          },
          cause,
        );
      });
  };

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  const copyButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            onClick={handleCopy}
            aria-label={copyLabel}
          />
        }
      >
        <MorphIcon className="size-3" icon={copied ? Check : Copy} />
      </TooltipTrigger>
      <TooltipPopup side="top">{copyLabel}</TooltipPopup>
    </Tooltip>
  );

  if (diagram) {
    return (
      <div className="my-[0.65rem] border border-transparent" data-language={language}>
        <div className="flex items-center justify-end gap-0.5 pt-1.5 pr-1.5 select-none">
          {viewToggle}
          {copyButton}
        </div>
        {children}
      </div>
    );
  }

  return (
    <MarkdownCodeBlockFrame
      language={language}
      fenceTitle={fenceTitle}
      theme={theme}
      wrapped={wrapped}
      headerProps={THREAD_FIND_IGNORE_PROPS}
      actions={
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          {canWrap ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant={wrapped ? "secondary" : "ghost-muted"}
                    size="icon-xs"
                    aria-pressed={wrapped}
                    onClick={() => setWrapped((value) => !value)}
                    aria-label={wrapLabel}
                  />
                }
              >
                <WrapTextIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          {canRun ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    onClick={() => onRunShellCommand(command)}
                    aria-label="Run in terminal"
                  />
                }
              >
                <PlayIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Run in terminal</TooltipPopup>
            </Tooltip>
          ) : null}
          {viewToggle}
          {copyButton}
        </span>
      }
    >
      {children}
    </MarkdownCodeBlockFrame>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

: SuspenseShikiCodeBlockProps) {
  const [hasStreamed, setHasStreamed] = useState(isStreaming);
  if (isStreaming && !hasStreamed) setHasStreamed(true);
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  // Once lines are mounted individually, keep that renderer when streaming
  // finishes so switching to cached HTML cannot clear an existing selection.
  const cachedHighlightedHtml =
    !isStreaming && !hasStreamed ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
      preserveLines={isStreaming || hasStreamed}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
  preserveLines: boolean;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
  preserveLines,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const incrementalHighlight = preserveLines
    ? createIncrementalHighlightedDocument(highlighter, language, themeName)
    : null;
  const highlighted = (() => {
    try {
      if (incrementalHighlight) return incrementalHighlight(code);
      return preserveLines
        ? highlighter.codeToHast(code, { lang: language, theme: themeName })
        : highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      return preserveLines
        ? highlighter.codeToHast(code, { lang: "text", theme: themeName })
        : highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  })();

  useEffect(() => {
    if (!isStreaming) {
      const highlightedHtml = typeof highlighted === "string" ? highlighted : toHtml(highlighted);
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlighted, isStreaming]);

  return typeof highlighted === "string" ? (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlighted }} />
  ) : (
    <div className="chat-markdown-shiki">
      <HighlightedCodeLines root={highlighted} />
    </div>
  );
}

interface MarkdownFileLinkProps {
  environmentId: EnvironmentId | null;
  href: string;
  targetPath: string;
  iconPath: string;
  displayPath: string;
  panelPath: string | null;
  line?: number | undefined;
  label: string;
  copyMarkdown: string;
  theme: "light" | "dark";
  threadRef?: ScopedThreadRef | undefined;
  onOpen?: ((targetPath: string) => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  onOpenInPanel: (panelPath: string, line: number | undefined) => void;
  openInEditorMenuLabel: string;
  onOpenInBrowser?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  onOpenMedia?: (() => void) | undefined;
  onReveal?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  revealLabel?: string | undefined;
}

const MARKDOWN_FILE_LINK_CLASS_NAME = "chat-markdown-file-link";

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

const MARKDOWN_LINK_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

const failedFaviconHosts = new Set<string>();

function isGitHubHost(host: string): boolean {
  const hostname = host.toLowerCase();
  return hostname === "github.com" || hostname.endsWith(".github.com");
}

const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string }) {
  const [failedHost, setFailedHost] = useState<string | null>(null);
  const brandIcon = isGitHubHost(host);
  const faviconUrl = brandIcon ? null : faviconUrlForOrigin(`https://${host}`);
  return (
    <span
      className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
      aria-hidden
    >
      {brandIcon ? (
        <GitHubIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      ) : faviconUrl === null || failedHost === host || failedFaviconHosts.has(host) ? (
        <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      ) : (
        <img
          src={faviconUrl}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn(MARKDOWN_LINK_FAVICON_CLASS_NAME, "rounded-sm")}
          onError={() => {
            failedFaviconHosts.add(host);
            setFailedHost(host);
          }}
        />
      )}
    </span>
  );
});

const CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME = "max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME = cn(
  "max-h-[30rem]",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
);
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
const CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME = "rounded-lg border border-border/40";
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  "h-auto w-auto object-contain",
  CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
);


/**
 * `maxHeightRem` folds a height cap into the width bound: `max-height` alone
 * would not feed back through `aspect-ratio` once `width` is definite, so a
 * tall image would keep a box wider than the picture it draws.
 */

const CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME = cn(
  CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);
const MarkdownLinkContext = React.createContext(false);

function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  alt: string,
) {
  if (!onImageExpand) return {};
  const previewName = alt.trim() || "image";
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = markdownImageItems.get(event.currentTarget);
    if (item) onImageExpand(markdownImageGallery(event.currentTarget, item));
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${previewName}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}

function ChatMarkdownMediaUnavailableLabel(props: {
  readonly alt: string;
  readonly kind?: "image" | "video" | undefined;
  readonly detail?: string | undefined;
}) {
  const label = props.kind === "video" ? "Video unavailable" : "Image unavailable";
  return (
    <span data-thread-find-ignore className="inline-flex items-center gap-1.5">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {[label, props.alt, props.detail].filter(Boolean).join(" · ")}
    </span>
  );
}

) {
  const content = (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        "rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      <ChatMarkdownMediaUnavailableLabel alt={props.alt} kind={props.kind} detail={props.detail} />
    </span>
  );
  return props.actionsSource ? (
    <MediaActions source={props.actionsSource}>{content}</MediaActions>
  ) : (
    content
  );
}

const CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME = cn(
  "aspect-video w-full overflow-hidden bg-muted/60",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);

/**
 * Callers key this on the file's identity, not its URL: a re-signed URL for
 * the same file keeps the decoded image on screen while the new bytes arrive,
 * and a different file starts from the slot again.
 */
) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = props.src ?? loadedSrc;
  const failed = props.sourceFailed === true || (src !== null && failedSrc === src);
  const settled = src !== null && !failed && (!props.standalone || loadedSrc !== null);
  // Cached images are complete before `onLoad` can fire.
  const markLoadedIfComplete = (image: HTMLImageElement | null) => {
    if (!image) return;
    if (image.complete && image.naturalWidth > 0) setLoadedSrc(image.currentSrc || image.src);
    markdownImageItems.set(image, {
      src,
      name: props.alt.trim() || "image",
      actionsSource: props.actionsSource,
      ...(props.originalUrl ? { originalUrl: props.originalUrl } : {}),
    });
  };
  const imageEvents = (loadingSrc: string) => ({
    onLoad: () => {
      setLoadedSrc(loadingSrc);
      setFailedSrc(null);
    },
    onError: () => {
      setFailedSrc(loadingSrc);
      setLoadedSrc(null);
    },
  });

  if (settled) {
    return (
      <MediaActions source={props.actionsSource}>
        <img
          {...props.imageProps}
          ref={markLoadedIfComplete}
          src={src}
          alt={props.alt}
          data-markdown-copy={props.copyMarkdown}
          decoding="async"
          draggable={false}
          className={cn(
            CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
            props.className,
            props.onImageExpand && "cursor-zoom-in",
          )}
          style={props.style}
          {...expandableMarkdownImageProps(props.onImageExpand, props.alt)}
          {...imageEvents(src)}
        />
      </MediaActions>
    );
  }
  if (!props.standalone) {
    return failed ? (
      <ChatMarkdownImageFallback
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        actionsSource={props.actionsSource}
        detail={props.unavailableDetail}
      />
    ) : (
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        role="status"
        aria-label="Loading image"
        className={CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME}
      />
    );
  }
  return (
    <MediaActions source={props.actionsSource}>
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        className={cn(
          CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
          CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME,
          "relative",
        )}
        style={props.style}
        {...(failed
          ? { role: "alert" as const }
          : { role: "status" as const, "aria-label": "Loading image" })}
      >
        {failed ? (
          <span className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
            <ChatMarkdownMediaUnavailableLabel alt={props.alt} detail={props.unavailableDetail} />
          </span>
        ) : src !== null ? (
          <img
            ref={markLoadedIfComplete}
            src={src}
            alt={props.alt}
            decoding="async"
            draggable={false}
            className="invisible absolute inset-0 size-full"
            {...imageEvents(src)}
          />
        ) : null}
      </span>
    </MediaActions>
  );
}

) {
  return (
    <MediaVideoPlayer
      key={props.mediaIdentity ?? props.copyMarkdown ?? props.src}
      src={props.src}
      sourceFailed={props.sourceFailed}
      label={props.alt}
      originalUrl={props.originalUrl}
      style={props.style}
      copyMarkdown={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
        "w-full",
      )}
      videoClassName={cn(
        CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
      )}
      onRetry={props.onRetry}
      actionsSource={props.actionsSource}
    />
  );
}

export const ChatMarkdownAssetImage = memo(function ChatMarkdownAssetImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<
    AssetResource,
    {
      readonly _tag:
        | "attachment"
        | "workspace-file"
        | "media-file"
        | "github-media"
        | "azure-devops-media"
        | "tool-output-image";
    }
  >;
  readonly kind?: "image" | "video";
  readonly alt: string;
  readonly copyMarkdown?: string;
  readonly srcFragment?: string;
  readonly standalone?: boolean | undefined;
  readonly maxHeightRem?: number | undefined;
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly originalUrl?: string | undefined;
  readonly framed?: boolean | undefined;
  readonly fallbackSrc?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, props.resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, props.resource);
  const resource = props.resource;
  const path =
    resource._tag === "media-file"
      ? resource.path
      : resource._tag === "workspace-file" && props.workspaceRoot
        ? `${props.workspaceRoot.replace(/[\\/]+$/, "")}/${resource.path}`
        : undefined;
  const reference = path
    ? mediaFileReference(path, props.workspaceRoot)
    : props.originalUrl
      ? mediaUrlReference(props.originalUrl)
      : undefined;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  const fallbackSrc = assetUrl._tag === "Failure" ? props.fallbackSrc : undefined;
  const src =
    assetUrl._tag === "Success"
      ? assetUrl.url + (props.srcFragment ?? "")
      : fallbackSrc === undefined
        ? null
        : fallbackSrc + (props.srcFragment ?? "");
  const knownSize = assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined;
  const maxHeightRem = props.maxHeightRem ?? 30;
  const style =
    props.style ??
    (knownSize
      ? authoredImageSizeStyle(knownSize.width, knownSize.height, maxHeightRem)
      : maxHeightRem !== 30
        ? { maxHeight: `${maxHeightRem}rem` }
        : undefined);
  const actionsSource: MediaActionSource = {
    kind: props.kind ?? "image",
    name: props.alt || (props.kind ?? "image"),
    src,
    ...(fallbackSrc === undefined
      ? { asset: { environmentId: props.environmentId, resource } }
      : {}),
    ...(reference ? { reference } : {}),
    ...(relativePath && (resource._tag === "media-file" || resource._tag === "workspace-file")
      ? {
          onOpenFile: () =>
            useRightPanelStore
              .getState()
              .openFile(
                { environmentId: props.environmentId, threadId: resource.threadId },
                relativePath,
              ),
        }
      : {}),
  };

  if (props.kind === "video") {
    return (
      <ChatMarkdownVideo
        src={src}
        sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        originalUrl={props.originalUrl}
        style={props.style}
        mediaIdentity={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
        onRetry={refreshAssetUrl}
        actionsSource={actionsSource}
      />
    );
  }

  return (
    <ChatMarkdownImage
      key={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
      src={src}
      sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
      unavailableDetail={
        assetUrl._tag === "Failure" &&
        assetUrl.reason === "missing-file-access" &&
        fallbackSrc === undefined
          ? MISSING_FILE_ACCESS_MESSAGE
          : undefined
      }
      alt={props.alt}
      copyMarkdown={props.copyMarkdown}
      standalone={props.standalone ?? true}
      className={cn(
        props.framed === false ? undefined : CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME,
        props.className,
      )}
      style={style}
      imageProps={props.imageProps}
      actionsSource={actionsSource}
      originalUrl={props.originalUrl}
      onImageExpand={props.onImageExpand}
    />
  );
});






const SANITIZED_FRAGMENT_PREFIX = "user-content-";



const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

function orderedListGutterStyle(
  itemCount: number,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` };
}

const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
> = {
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-blue-600 dark:text-blue-400",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-red-500/70",
    titleClassName: "text-red-600 dark:text-red-400",
  },
};

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

// Heading ids are added after sanitizing, which would prefix them a second time.
const CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS = [
  ...CHAT_MARKDOWN_REHYPE_PLUGINS,
  rehypeHeadingIds,
  rehypeTextDirection,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

const CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS = [
  rehypeHeadingIds,
  rehypeTextDirection,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

const NO_MARKDOWN_EDITORS: ReadonlyArray<EditorId> = [];

type MarkdownServerConfigFields = ReturnType<typeof markdownServerConfigFields>;

function markdownServerConfigFields(config: ServerConfig | null) {
  return {
    pullRequestsEnabled: config?.environment.capabilities.pullRequests === true,
    availableEditors: config?.availableEditors ?? NO_MARKDOWN_EDITORS,
    revealInFileManagerLabel:
      config?.shellRevealInFileManager === true && config.availableEditors.includes("file-manager")
        ? config.shellRevealInFileManagerKind === undefined
          ? revealInFileExplorerLabelForOs(config.environment.platform.os)
          : revealInFileExplorerLabelForKind(config.shellRevealInFileManagerKind)
        : undefined,
  };
}

function markdownServerConfigFieldsEqual(
  previous: MarkdownServerConfigFields,
  next: MarkdownServerConfigFields,
): boolean {
  return (
    previous.pullRequestsEnabled === next.pullRequestsEnabled &&
    previous.revealInFileManagerLabel === next.revealInFileManagerLabel &&
    previous.availableEditors.length === next.availableEditors.length &&
    previous.availableEditors.every((editor, index) => editor === next.availableEditors[index])
  );
}

// Compare only markdown config fields to avoid rerendering replies on every provider status push.
const markdownServerConfigFieldsAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => {
    const next = markdownServerConfigFields(get(serverEnvironment.configValueAtom(environmentId)));
    const previous = Option.getOrNull(get.self<MarkdownServerConfigFields>());
    return previous !== null && markdownServerConfigFieldsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("markdown-server-config-fields")),
);

function useChatMarkdownState({
  text,
  inline = false,
  cwd,
  threadRef,
  pullRequestPanelRef,
  environmentId: explicitEnvironmentId,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  onUseArtifactTemplate,
  onRunShellCommand,
  imageBaseDir,
  workspaceMutationId,
  onImageExpand,
  renderContextReference,
  headingLevelOffset = 0,
  sourceControlMedia = false,
}: ChatMarkdownProps) {
  const resolvedTheme = useRenderedAppearance();
  const markdownRef = useRef<HTMLElement>(null);
  const mediaRequestId = useRef(0);
  const mediaScopeKey = [
    threadRef?.environmentId,
    threadRef?.threadId,
    explicitEnvironmentId,
    cwd,
    imageBaseDir,
  ].join("\u0000");
  // Hide requests from an old scope even if they resolve before effect cleanup.
  const [localMedia, setLocalMedia] = useState<{
    scope: string;
    preview: ExpandedImagePreview;
  } | null>(null);
  const localMediaPreview = localMedia?.scope === mediaScopeKey ? localMedia.preview : null;
  const closeLocalMediaPreview = () => setLocalMedia(null);
  const expandMedia =
    onImageExpand ??
    ((preview: ExpandedImagePreview) => setLocalMedia({ scope: mediaScopeKey, preview }));
  const [mediaScope, setMediaScope] = useState(mediaScopeKey);
  if (mediaScope !== mediaScopeKey) {
    setMediaScope(mediaScopeKey);
    setLocalMedia(null);
  }
  // Layout cleanup blocks stale requests from reaching onImageExpand before paint.
  useLayoutEffect(
    () => () => {
      mediaRequestId.current += 1;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Leaving the scope invalidates media requests still loading for it.
    [mediaScopeKey],
  );
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const searchProjectEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  const getFilesystemMetadata = useAtomQueryRunner(filesystemEnvironment.getMetadata, {
    reportFailure: false,
    refresh: true,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const pullRequestLinking = usePullRequestLinking(threadRef?.environmentId);
  const environmentId = threadRef?.environmentId ?? explicitEnvironmentId ?? null;
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const canUseShellActions =
    canOperateHost &&
    canUseMarkdownFileShellActions(environmentId, remoteOpen.state.mode, remoteOpen.isResolved);
  const openMarkdownMedia = (
    source: string,
    resolvedFilePath?: string,
    clickedImage?: HTMLImageElement | null,
  ) => {
    const requestId = ++mediaRequestId.current;
    void resolveMarkdownMediaPreview({
      source,
      resolvedFilePath,
      cwd,
      threadRef,
      // Read the connection on click; reconnect replaces it, and subscriptions would refresh every markdown
      // context.
      httpBaseUrl:
        environmentId === null ? undefined : readPreparedConnection(environmentId)?.httpBaseUrl,
      createAssetUrl,
      onOpenFile: threadRef
        ? (path) => useRightPanelStore.getState().openFile(threadRef, path)
        : undefined,
    }).then(
      (preview) => {
        if (preview && mediaRequestId.current === requestId) {
          const selected = preview.images[preview.index];
          expandMedia(
            selected && selected.type !== "video" && markdownRef.current
              ? markdownImageGallery(clickedImage ?? markdownRef.current, selected)
              : preview,
          );
        }
      },
      (error: unknown) => {
        if (mediaRequestId.current !== requestId) return;
        let description =
          error instanceof Error
            ? error.message
            : "The file could not be loaded. It may have been moved or deleted.";
        if (
          isAssetNotFoundError(error) &&
          error.resource._tag === "media-file" &&
          environmentId !== null
        ) {
          // The connection may resolve while the media lookup is pending.
          const target = readPreparedConnection(environmentId)?.target ?? null;
          if (
            target !== null &&
            resolveRemoteOpenState({
              target,
              sshTarget: null,
              remoteOpenTargets: undefined,
              isDesktopRenderer: window.desktopBridge !== undefined,
            }).mode !== "local-exec"
          ) {
            description = `The file was not found on ${target.label} at ${error.checkedPath ?? error.resource.path}.`;
          }
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Media unavailable",
            description,
          }),
        );
      },
    );
  };
  const { pullRequestsEnabled, availableEditors, revealInFileManagerLabel } = useAtomValue(
    markdownServerConfigFieldsAtom(environmentId),
  );
  const projects = useProjects();
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const preferredEditorMenuLabel = openInEditorMenuLabel(preferredEditor);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const revealFileInFileManager = (filePath: string) => {
    if (environmentId === null) {
      return Promise.resolve(
        AsyncResult.failure<void, PreferredEditorEnvironmentRequiredError>(
          Cause.fail(new PreferredEditorEnvironmentRequiredError({ targetPath: filePath })),
        ),
      );
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return Promise.resolve(
        AsyncResult.failure<void, Error>(
          Cause.fail(new Error("This connection cannot reveal files on this environment.")),
        ),
      );
    }
    return openInEditor({
      environmentId,
      input: { cwd: filePath, editor: "file-manager", reveal: true },
    });
  };
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownFileLinkMetaByHref = (() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of extractMarkdownLinkHrefs(renderCodexInlineDirectivesAsMarkdown(text))) {
      if (parseComposerContextHref(href) || parseThreadLinkHref(href)) continue;
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  })();
  const inlineCodeFileLinkMetaByText = (() => {
    const metaByText = new Map<string, MarkdownFileLinkMeta>();
    for (const span of extractInlineCodeSpans(text)) {
      if (metaByText.has(span)) continue;
      const meta = resolveInlineCodeFileLinkMeta(span, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByText.set(span, meta);
      }
    }
    return metaByText;
  })();
  const fileLinkParentSuffixByPath = (() => {
    const filePaths = [
      ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
      ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
    ];
    return buildFileLinkParentSuffixByPath(filePaths);
  })();
  const markdownUrlTransform = (href: string) => {
    if (parseAssistantCitationHref(href)) return href;
    if (parseComposerContextHref(href)) return href;
    if (parseThreadLinkHref(href) || parseForkThreadLinkHref(href)) return href;
    if (isWindowsDrivePathHref(href)) return href;
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  };
  const handleCopy = (event: ReactClipboardEvent<HTMLElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    const fragment = event.clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME);
    event.clipboardData.setData(
      "text/html",
      fragment
        ? encodeComposerContextClipboardHtml(payload.text, fragment, payload.html)
        : payload.html,
    );
  };
  const openChangeRequestLink = useOpenChangeRequestLink(threadRef, pullRequestPanelRef);
  const openDeferredMarkdownLink = useOpenLink(threadRef);
  // Subscribe so hydrated settings apply before the anchor synchronously decides whether to intercept _blank.
  const linkTargetPreference = useClientSettings((settings) => settings.browserLinkTarget);
  const mathEnabled = useClientSettings((settings) => settings.mathRenderingEnabled);
  const resolveThreadPullRequest = (
    href: string,
  ): (ThreadPullRequestKey & { readonly url: string }) | null => {
    if (
      threadRef === undefined ||
      readThreadShell(threadRef) === null ||
      !pullRequestLinking.canLink(href)
    )
      return null;
    const parsed = sourceControlClients.parseChangeRequestUrl(href)?.link;
    return parsed === undefined ? null : { ...parsed, url: href };
  };
  const linkedThreadPullRequestFor = (href: string) => {
    if (threadRef === undefined || !pullRequestLinking.isLinked(readThreadShell(threadRef), href))
      return null;
    const parsed = sourceControlClients.parseChangeRequestUrl(href)?.link;
    return parsed === undefined ? null : { ...parsed, url: href };
  };
  const updateThreadPullRequestLink = async (href: string, linked: boolean) => {
    if (threadRef === undefined || (!linked && linkedThreadPullRequestFor(href) === null)) return;
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    await pullRequestLinking.changeLink(threadRef, href, linked);
  };
  const openExternalLinkInPreview = (url: string) => {
    if (!threadRef || !canOperatePreview) {
      return Promise.resolve(
        AsyncResult.failure<void, BrowserPreviewUnavailableError>(
          Cause.fail(
            new BrowserPreviewUnavailableError({
              message: "Preview access is unavailable for this client.",
            }),
          ),
        ),
      );
    }
    return openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
      if (result._tag === "Success") recordVisitForThread(threadRef, url);
      else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        if (error instanceof BrowserSettingsReadError) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open link in browser",
              description: error.message,
            }),
          );
        }
      }
      return result;
    });
  };
  const openMarkdownFileInPreview = (path: string) => {
    const preparedConnection = threadRef ? readPreparedConnection(threadRef.environmentId) : null;
    if (!threadRef || !canOperatePreview || preparedConnection === null) {
      return Promise.resolve(
        AsyncResult.failure<void, BrowserPreviewUnavailableError>(
          Cause.fail(
            new BrowserPreviewUnavailableError({
              message: "Environment is not connected.",
            }),
          ),
        ),
      );
    }
    return openFileInPreview({
      threadRef,
      filePath: path,
      workspaceRoot: cwd,
      httpBaseUrl: preparedConnection.httpBaseUrl,
      createAssetUrl,
      openPreview,
    });
  };
  const findWorkspaceFileMatch = async (fileLinkMeta: MarkdownFileLinkMeta) => {
    const workspaceRelativePath = fileLinkMeta.workspaceLookupPath;
  const resolveNestedRepoFile = useNestedRepoFileLinkResolver(environmentId, cwd);
  const findWorkspaceFileMatch = async (fileLinkMeta: MarkdownFileLinkMeta) => {
    const workspaceRelativePath = fileLinkMeta.workspaceLookupPath;
    if (workspaceRelativePath === null) return null;
    if (needsNestedRepoFileLookup(workspaceRelativePath)) {
      return resolveNestedRepoFile(workspaceRelativePath);
    }
    if (
      !workspaceRelativePath ||
      !cwd ||
      environmentId === null ||
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
    ) {
      return null;
    }
    const isBasename = needsWorkspaceBasenameLookup(workspaceRelativePath);
    const strippedPath = isBasename
      ? null
      : stripRepeatedWorkspacePrefix(workspaceRelativePath, cwd);
    if (!isBasename && strippedPath === null) return null;
    const result = await searchProjectEntries({
      environmentId,
      input: {
        cwd,
        query: strippedPath ?? workspaceRelativePath,
        limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
        kind: "file",
      },
    });
    if (result._tag !== "Success") return null;
    if (strippedPath === null) {
      return pickWorkspaceBasenameMatch(workspaceRelativePath, result.value.entries);
    }
    const match = pickStrippedWorkspaceMatch(strippedPath, cwd, result.value.entries);
    if (match === null) return null;
    // Search can be truncated or still scanning, so it cannot rule out the
    // literal path. Check the host before redirecting to the stripped match.
    const metadata = await getFilesystemMetadata({
      environmentId,
      input: { paths: [resolveWorkspaceFilePath(workspaceRelativePath, cwd)] },
    });
    return metadata._tag === "Success" && metadata.value.entries[0] === null ? match : null;
  };
  const openFileInPanel = (fileLinkMeta: MarkdownFileLinkMeta, panelPath: string) => {
    if (!threadRef) return;
    // Every open supersedes pending lookups, including synchronous opens.
    const isLatestLookup = claimWorkspaceBasenameLookup();
    const openAt = (path: string) =>
      useRightPanelStore.getState().openFile(threadRef, path, fileLinkMeta.line);
    if (
      fileLinkMeta.workspaceLookupPath === null ||
      !cwd ||
      (!needsWorkspaceBasenameLookup(panelPath) &&
        !needsNestedRepoFileLookup(panelPath) &&
        stripRepeatedWorkspacePrefix(panelPath, cwd) === null)
    ) {
      openAt(panelPath);
      return;
    }
    void (async () => {
      const match = await findWorkspaceFileMatch(fileLinkMeta);
      if (!isLatestLookup()) return;
      openAt(match ?? panelPath);
    })();
  };
  const fileLinkChip = (
    fileLinkMeta: MarkdownFileLinkMeta,
    copyMarkdown: string,
    mediaSource?: string,
  ) => {
    const resolveHostPath = () =>
      resolveMarkdownFileHostPath({
        meta: fileLinkMeta,
        cwd,
        findWorkspaceMatch: () => findWorkspaceFileMatch(fileLinkMeta),
      });
    const mediaPath = mediaSource ?? fileLinkMeta.filePath;
    const canPreviewMedia =
      mediaMimeTypeFromExtension(
        fileLinkMeta.basename.slice(fileLinkMeta.basename.lastIndexOf(".")),
      ) !== null;
    const panelPath =
      fileLinkMeta.workspaceRelativePath ??
      (!canPreviewMedia && isHostPath(fileLinkMeta.filePath) ? fileLinkMeta.filePath : null);

    return (
      <MarkdownFileLink
        environmentId={environmentId}
        href={fileLinkMeta.targetPath}
        targetPath={fileLinkMeta.targetPath}
        iconPath={fileLinkMeta.filePath}
        workspaceRelativePath={fileLinkMeta.workspaceRelativePath}
        panelPath={panelPath}
        line={fileLinkMeta.line}
        label={fileLinkLabel(
          {
            path: fileLinkMeta.filePath,
            ...(fileLinkMeta.line !== undefined ? { line: fileLinkMeta.line } : {}),
            ...(fileLinkMeta.column !== undefined ? { column: fileLinkMeta.column } : {}),
          },
          fileLinkParentSuffixByPath,
        )}
        copyMarkdown={copyMarkdown}
        theme={resolvedTheme}
        threadRef={threadRef}
        onOpen={
          canUseShellActions
            ? async () =>
                openInPreferredEditor(
                  markdownFileEditorTarget(fileLinkMeta, await resolveHostPath()),
                )
            : undefined
        }
        resolveCopyPaths={async () =>
          markdownFileCopyPaths(fileLinkMeta, await resolveHostPath(), cwd)
        }
        onOpenInPanel={(path) => openFileInPanel(fileLinkMeta, path)}
        onOpenMedia={
          threadRef && canPreviewMedia
            ? () => openMarkdownMedia(mediaPath, fileLinkMeta.filePath)
            : undefined
        }
        openInEditorMenuLabel={preferredEditorMenuLabel}
        onReveal={
          canUseShellActions && revealInFileManagerLabel !== undefined
            ? async () => revealFileInFileManager((await resolveHostPath()).absolutePath)
            : undefined
        }
        revealLabel={revealInFileManagerLabel}
        onOpenInBrowser={
          threadRef &&
          canOperatePreview &&
          isPreviewAvailableFor(threadRef.environmentId) &&
          isBrowserPreviewFile(fileLinkMeta.filePath)
            ? () => openMarkdownFileInPreview(fileLinkMeta.filePath)
            : undefined
        }
      />
    );
  };

  const componentState = {
    canOperateHost,
    canOperatePreview,
    cwd,
    diffThemeName,
    environmentId,
    expandMedia,
    fileLinkChip,
    sourceControlMedia,
    renderContextReference,
    headingLevelOffset,
    imageBaseDir,
    workspaceMutationId,
    inlineCodeFileLinkMetaByText,
    inline,
    mathEnabled,
    isStreaming,
    linkTargetPreference,
    markdownFileLinkMetaByHref,
    onTaskListChange,
    onUseArtifactTemplate,
    onRunShellCommand,
    openChangeRequestLink,
    openDeferredMarkdownLink,
    openExternalLinkInPreview,
    openMarkdownMedia,
    projects,
    linkedThreadPullRequestFor,
    resolveThreadPullRequest,
    resolvedTheme,
    pullRequestsEnabled,
    skills,
    threadRef,
    updateThreadPullRequestLink,
  };
  return {
    componentState,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    closeLocalMediaPreview,
  };
}

const ChatMarkdownRendererContext = React.createContext<
  ReturnType<typeof useChatMarkdownState>["componentState"]
>(null!);

// Isolate streamed source text from the renderer context; only offset-based renderers need it.
const ChatMarkdownTextContext = React.createContext("");

function markdownHeadingRenderer(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({
    node: _node,
    ...props
  }: ComponentProps<typeof Tag> & ReactMarkdownExtraProps) {
    const { headingLevelOffset } = use(ChatMarkdownRendererContext);
    return (
      <Tag
        {...props}
        aria-level={headingLevelOffset > 0 ? Math.min(level + headingLevelOffset, 6) : undefined}
      />
    );
  };
}

const CHAT_MARKDOWN_COMPONENTS = {
  h1: markdownHeadingRenderer(1),
  h2: markdownHeadingRenderer(2),
  h3: markdownHeadingRenderer(3),
  h4: markdownHeadingRenderer(4),
  h5: markdownHeadingRenderer(5),
  h6: markdownHeadingRenderer(6),
  div: function MarkdownDiv({ node, children, ...props }) {
    const { onUseArtifactTemplate } = use(ChatMarkdownRendererContext);
    const artifactTemplate = artifactTemplateFromHastProperties(node?.properties);
    if (artifactTemplate) {
      return (
        <CodexArtifactTemplateCard template={artifactTemplate} onUse={onUseArtifactTemplate} />
      );
    }
    return <div {...props}>{children}</div>;
  },
  p: function MarkdownParagraph({ node: _node, children, ...props }) {
    const { skills } = use(ChatMarkdownRendererContext);
    return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
  },
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const alert =
      GITHUB_ALERT_PRESENTATIONS[String((props as Record<string, unknown>)["data-alert"] ?? "")];
    if (!alert) {
      return <blockquote {...props}>{children}</blockquote>;
    }
    return (
      <div
        role="note"
        dir={props.dir}
        className={cn("my-1 border-s-2 ps-3", alert.borderClassName)}
      >
        <p
          data-thread-find-ignore="true"
          className={cn("flex items-center gap-1.5 font-medium", alert.titleClassName)}
        >
          <alert.Icon aria-hidden className="size-3.5 shrink-0" />
          {alert.label}
        </p>
        {children}
      </div>
    );
  },
  ol: function MarkdownOrderedList({ node, start, style, ...props }) {
    const itemCount =
      node?.children?.filter((child) => child.type === "element" && child.tagName === "li")
        .length ?? 0;
    const gutterStyle = orderedListGutterStyle(itemCount, start);
    return (
      <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
    );
  },
  li: function MarkdownListItem({ node, children, ...props }) {
    const { skills } = use(ChatMarkdownRendererContext);
    // Resolve checkbox markers by offset to avoid rerendering list items on every streamed token.
    const isTaskItem = String(props.className ?? "").includes("task-list-item");
    return (
      <li {...props} data-list-item-offset={isTaskItem ? node?.position?.start.offset : undefined}>
        {renderSkillInlineMarkdownChildren(children, skills)}
      </li>
    );
  },
  input: function MarkdownInput({ node: _node, type, checked, disabled: _disabled, ...props }) {
    const { onTaskListChange } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    if (type !== "checkbox" || !onTaskListChange) {
      return (
        <input
          {...props}
          type={type}
          checked={checked}
          disabled={_disabled}
          readOnly={type === "checkbox"}
        />
      );
    }
    return (
      <input
        {...props}
        type="checkbox"
        name="markdown-task"
        aria-label="Toggle task"
        checked={checked}
        onChange={(event) => {
          const listItemStart = Number(event.currentTarget.closest("li")?.dataset.listItemOffset);
          if (!Number.isSafeInteger(listItemStart)) return;
          const markerOffset = findTaskListMarkerOffset(text, listItemStart);
          if (markerOffset === null) return;
          onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
        }}
      />
    );
  },
  a: function MarkdownAnchor({ node, href, children, title: _title, ...props }) {
    const {
      canOperateHost,
      canOperatePreview,
      cwd,
      environmentId,
      imageBaseDir,
      markdownFileLinkMetaByHref,
      threadRef,
      openMarkdownMedia,
      openChangeRequestLink,
      openDeferredMarkdownLink,
      linkTargetPreference,
      openExternalLinkInPreview,
      projects,
      linkedThreadPullRequestFor,
      resolveThreadPullRequest,
      pullRequestsEnabled,
      updateThreadPullRequestLink,
      fileLinkChip,
      renderContextReference,
    } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    const citation = href ? parseAssistantCitationHref(href) : null;
    if (citation) return <AssistantCitationChip citation={citation} />;
    const linkedThreadId = href ? parseThreadLinkHref(href) : null;
    if (linkedThreadId) {
      const label = hastPlainTextDeep(node) || linkedThreadId;
      return environmentId ? (
        <MarkdownThreadLink environmentId={environmentId} threadId={linkedThreadId} label={label} />
      ) : (
        <span>{label}</span>
      );
    }
    // Fork: thread orchestration chips for `t3-thread:<id>` links.
    const forkLinkedThreadId = href ? parseForkThreadLinkHref(href) : null;
    const chipEnvironmentId = threadRef?.environmentId ?? environmentId;
    if (forkLinkedThreadId && chipEnvironmentId) {
      return (
        <ThreadLinkChip
          environmentId={chipEnvironmentId}
          threadId={forkLinkedThreadId}
          label={hastPlainTextDeep(node) || "Thread"}
        />
      );
    }
    const contextReference = href ? parseComposerContextHref(href) : null;
    if (contextReference) {
      const label = hastPlainTextDeep(node) || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }
    const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
    const fileLinkMeta = normalizedHref
      ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
        resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd))
      : null;
    if (!fileLinkMeta) {
      const faviconHost = resolveExternalWebLinkHost(href);
      const hasText = hastHasText(node);
      const pullRequestAutolink = String(
        (props as Record<string, unknown>)["data-pull-request-autolink"] ?? "",
      );
      const pullRequestCopy =
        pullRequestAutolink === "commit"
          ? /\/commit\/([0-9a-f]{7,40})$/iu.exec(href ?? "")?.[1]
          : pullRequestAutolink === "reference" || pullRequestAutolink === "mention"
            ? plainHastText(node)
            : undefined;
      const isPullRequestAutolink = pullRequestCopy !== undefined;
      const confirmBeforeOpen = pullRequestAutolink === "reference";
      const pullRequestCandidateUrl =
        confirmBeforeOpen && href
          ? sourceControlClients.changeRequestUrlFromReferenceAutolink(href)
          : href;
      const pullRequestPreviewTarget = pullRequestCandidateUrl
        ? resolvePullRequestPreviewTarget({
            environmentId,
            projects,
            pullRequestsEnabled,
            url: pullRequestCandidateUrl,
          })
        : null;
      const isSameDocumentLink = href?.startsWith("#") ?? false;
      const onClick = props.onClick;
      const canOpenInPreview =
        canOperatePreview && Boolean(threadRef && isPreviewAvailableFor(threadRef.environmentId));
      const linkChildren = <MarkdownLinkContext value>{children}</MarkdownLinkContext>;
      const link = (
        <a
          {...props}
          className={cn(props.className, pullRequestAutolink === "commit" && "font-mono")}
          data-markdown-copy={pullRequestCopy}
          data-markdown-image-link={!hasText || undefined}
          href={href}
          target={isSameDocumentLink ? undefined : "_blank"}
          rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
          onClick={(event) => {
            onClick?.(event);
            if (isSameDocumentLink && href) {
              handleMarkdownFragmentClick(event, href);
              return;
            }
            if (
              href &&
              faviconHost !== null &&
              mediaKindFromPath(href) !== null &&
              mediaKindFromPath(href) !== "audio" &&
              !event.defaultPrevented &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              event.stopPropagation();
              openMarkdownMedia(
                href,
                undefined,
                event.target instanceof HTMLImageElement
                  ? event.target
                  : event.currentTarget.querySelector("img"),
              );
              return;
            }
            if (
              !href ||
              openChangeRequestLink(event, href, undefined, environmentId ?? undefined)
            ) {
              return;
            }
            if (event.defaultPrevented) return;
            if (
              resolveLinkTarget({
                url: href,
                event,
                preference: linkTargetPreference,
                canOpenInApp: canOpenInPreview,
              }) !== "app"
            ) {
              // Open desktop Alt-clicks before Chromium downloads them so link routers can read the held key.
              if (isElectron && event.altKey) {
                event.preventDefault();
                event.stopPropagation();
                void readLocalApi()
                  ?.shell.openExternal(href)
                  .catch((cause) =>
                    reportMarkdownActionFailure(
                      { operation: "open-link-external", target: href },
                      cause,
                    ),
                  );
              }
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            void openExternalLinkInPreview(href).then((result) => {
              if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
              reportMarkdownActionFailure(
                { operation: "open-link-in-preview", target: href },
                result.cause,
              );
              if (squashAtomCommandFailure(result) instanceof BrowserSettingsReadError) return;
              void readLocalApi()?.shell.openExternal(href);
            });
          }}
          onContextMenu={(event) => {
            if (!href || !faviconHost) return;
            event.preventDefault();
            event.stopPropagation();
            const api = readLocalApi();
            if (!api) return;
            const threadLinkAction = !canOperateHost
              ? undefined
              : linkedThreadPullRequestFor(href) !== null
                ? "unlink-from-thread"
                : resolveThreadPullRequest(href) === null
                  ? undefined
                  : "link-to-thread";
            void showExternalLinkContextMenu({
              href,
              canOpenInPreview,
              threadLinkAction,
              position: { x: event.clientX, y: event.clientY },
              showContextMenu: (items, position) => api.contextMenu.show(items, position),
              openInPreview: async (target) => {
                const result = await openExternalLinkInPreview(target);
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                  reportMarkdownActionFailure(
                    { operation: "open-link-in-preview", target },
                    result.cause,
                  );
                }
              },
              openExternal: (target) => api.shell.openExternal(target),
              copyLink: (target) => writeTextToClipboard(target, "link"),
              updateThreadLink: updateThreadPullRequestLink,
              reportFailure: (operation, cause) => {
                reportMarkdownActionFailure({ operation, target: href }, cause);
                if (
                  operation === "link-pull-request-to-thread" ||
                  operation === "unlink-pull-request-from-thread"
                ) {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title:
                        operation === "link-pull-request-to-thread"
                          ? "Unable to link pull request"
                          : "Unable to unlink pull request",
                      description: cause instanceof Error ? cause.message : "The request failed.",
                    }),
                  );
                }
              },
            });
          }}
        >
          {faviconHost && hasText && !isPullRequestAutolink ? (
            <MarkdownExternalLinkContent host={faviconHost} plainText={plainHastText(node)}>
              {linkChildren}
            </MarkdownExternalLinkContent>
          ) : (
            linkChildren
          )}
        </a>
      );
      if (!faviconHost || !href) {
        return link;
      }
      if (pullRequestPreviewTarget !== null) {
        return (
          <PullRequestLinkPreview
            link={link}
            originalUrl={href}
            target={pullRequestPreviewTarget}
            confirmBeforeOpen={confirmBeforeOpen}
            onOpenPullRequest={(targetUrl) =>
              openChangeRequestLink(
                {
                  metaKey: false,
                  ctrlKey: false,
                  preventDefault: () => undefined,
                  stopPropagation: () => undefined,
                },
                targetUrl,
                undefined,
                environmentId ?? undefined,
              )
            }
            onOpenFallback={openDeferredMarkdownLink}
          />
        );
      }
      return (
        <Tooltip>
          <TooltipTrigger render={link} />
          <TooltipPopup side="top">{href}</TooltipPopup>
        </Tooltip>
      );
    }

    const label = nodeToPlainText(children);
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    const source = start !== undefined && end !== undefined ? text.slice(start, end) : "";
    const copyMarkdown =
      source.startsWith("[") && source.includes("](")
        ? source
        : `[${(label || fileLinkMeta.basename).replace(/[\\[\]]/g, "\\$&")}](${normalizedHref})`;
    const chip = fileLinkChip(fileLinkMeta, copyMarkdown, normalizedHref);
    return isMarkdownFileLinkLabel(label, normalizedHref) ? (
      chip
    ) : (
      <span data-markdown-copy={copyMarkdown}>
        {children} {chip}
      </span>
    );
  },
  code: function MarkdownCode({ node, children, className, ...props }) {
    const { cwd, imageBaseDir, inlineCodeFileLinkMetaByText, fileLinkChip, mathEnabled, inline } =
      use(ChatMarkdownRendererContext);
    const math = mathEnabled ? mathKind(className) : null;
    if (math) {
      return (
        <MarkdownMath
          tex={nodeToPlainText(children)}
          display={math === "display"}
          focusable={!inline}
        />
      );
    }
    if (node?.properties?.dataInlineCode != null) {
      const codeText = nodeToPlainText(children);
      const fileLinkMeta =
        inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
        resolveInlineCodeFileLinkMeta(codeText, cwd, imageBaseDir ?? cwd);
      if (fileLinkMeta) {
        return fileLinkChip(
          fileLinkMeta,
          `\`${codeText}\``,
          inlineCodeFilePathCandidate(codeText) ?? codeText.trim(),
        );
      }
    }
    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  },
  img: function MarkdownImage({ node, title, src, alt, ...props }) {
    const {
      expandMedia,
      cwd,
      environmentId,
      sourceControlMedia,
      imageBaseDir,
      threadRef,
      workspaceMutationId,
      renderContextReference,
      fileLinkChip,
    } = use(ChatMarkdownRendererContext);
    const imageExpand = use(MarkdownLinkContext) ? undefined : expandMedia;
    const contextReference = typeof src === "string" ? parseComposerContextHref(src) : null;
    if (contextReference) {
      const label = alt || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }
    const localSrc = node?.properties?.dataLocalSrc;
    const markdownTitle = node?.properties?.dataMarkdownTitle;
    const standalone = node?.properties?.dataStandalone === true;
    const authoredSrc = typeof localSrc === "string" ? localSrc : src;
    const authoredTitle = typeof markdownTitle === "string" ? markdownTitle : title;
    const srcString =
      typeof authoredSrc === "string" ? normalizeMarkdownLinkDestination(authoredSrc) : "";
    const classifiedSrc =
      typeof localSrc === "string" ? srcString.replaceAll("\\", "/") : srcString;
    const altText = alt ?? "";
    const copyMarkdown = markdownImageCopy(altText, srcString, authoredTitle);
    const { className, style: _style, width, height, ...imageProps } = props;
    const authoredSizeStyle = authoredImageSizeStyle(width, height);
    const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd);
    const mediaKind = mediaKindFromPath(classifiedSrc);
    if (mediaKind === "audio") {
      const filePath = imageSource._tag === "WorkspaceFile" ? imageSource.path : null;
      const name =
        (filePath ?? classifiedSrc.split(/[?#]/, 1)[0] ?? "").split(/[\\/]/).at(-1) ||
        altText ||
        "Audio";
      if (imageSource._tag !== "Direct" && !(filePath && threadRef)) {
        return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind="audio" />;
      }
      return (
        <InlineAudioPreview
          key={classifiedSrc}
          name={name}
          copyMarkdown={copyMarkdown}
          {...(filePath && threadRef
            ? {
                environmentId: threadRef.environmentId,
                resource: {
                  _tag: "media-file" as const,
                  threadId: threadRef.threadId,
                  path: filePath,
                },
                onOpen: () => useRightPanelStore.getState().openFile(threadRef, filePath),
              }
            : imageSource._tag === "Direct"
              ? { src: resolveProtocolRelativeMediaUrl(imageSource.uri) }
              : {})}
        />
      );
    }
    if (mediaKind === null && imageSource._tag === "WorkspaceFile") {
      const fileLinkMeta = resolveMarkdownFileLinkMeta(srcString, cwd, imageBaseDir ?? cwd);
      if (fileLinkMeta) return fileLinkChip(fileLinkMeta, copyMarkdown, srcString);
    }
    const kind = mediaKind ?? "image";
    const directUri = imageSource._tag === "Direct" ? imageSource.uri : null;
    const hostMediaUrl =
      directUri === null
        ? null
        : (sourceControlClients.mediaUrl(resolveProtocolRelativeMediaUrl(directUri))?.fetchUrl ??
          null);
    const pullRequestResource =
      directUri === null || cwd === undefined
        ? null
        : pullRequestMediaResource(cwd, resolveProtocolRelativeMediaUrl(directUri));
    if (
      sourceControlMedia &&
      cwd !== undefined &&
      environmentId !== null &&
      directUri !== null &&
      (hostMediaUrl !== null || pullRequestResource !== null)
    ) {
      return (
        <ChatMarkdownAssetImage
          environmentId={environmentId}
          resource={
            pullRequestResource ?? { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd, url: hostMediaUrl! }
          }
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          originalUrl={resolveProtocolRelativeMediaUrl(directUri)}
          framed={false}
          fallbackSrc={pullRequestResource?.url ?? hostMediaUrl!}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "Direct") {
      const mediaSrc = resolveProtocolRelativeMediaUrl(imageSource.uri);
      const originalUrl =
        resolveExternalWebLinkHost(imageSource.uri) !== null ? imageSource.uri : undefined;
      const reference = mediaUrlReference(imageSource.uri);
      const actionsSource: MediaActionSource = {
        kind,
        name: altText || kind,
        src: mediaSrc,
        ...(reference ? { reference } : {}),
      };
      if (kind === "video") {
        return (
          <ChatMarkdownVideo
            src={mediaSrc}
            alt={altText}
            copyMarkdown={copyMarkdown}
            originalUrl={originalUrl}
            style={authoredSizeStyle}
            actionsSource={actionsSource}
          />
        );
      }
      return (
        <ChatMarkdownImage
          key={mediaSrc}
          src={mediaSrc}
          alt={altText}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          actionsSource={actionsSource}
          originalUrl={originalUrl}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "WorkspaceFile" && threadRef) {
      return (
        <ChatMarkdownAssetImage
          environmentId={threadRef.environmentId}
          resource={{
            _tag: "media-file",
            threadId: threadRef.threadId,
            path: imageSource.path,
          }}
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          standalone={standalone}
          style={authoredSizeStyle}
          workspaceRoot={cwd}
          workspaceMutationId={workspaceMutationId}
          onImageExpand={imageExpand}
        />
      );
    }
    return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind={kind} />;
  },
  table: function MarkdownTableRenderer({ node: _node, ...props }) {
    return <MarkdownTable {...props} />;
  },
  details: function MarkdownDetailsRenderer({ node: _node, children, open: detailsOpen }) {
    return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const {
      resolvedTheme,
      diffThemeName,
      expandMedia,
      isStreaming,
      onRunShellCommand,
      inline,
      mathEnabled,
    } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }

    const language = extractFenceLanguage(codeBlock.className);
    if (
      mathEnabled &&
      language === "math" &&
      (!isStreaming ||
        mathKind(codeBlock.className) === "display" ||
        isClosedCodeFence(node, text, codeBlock.code))
    ) {
      return <MarkdownMath tex={codeBlock.code} display focusable={!inline} />;
    }
    const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
    const highlightedCode = (
      <RenderErrorBoundary
        resetKeys={[codeBlock.code, language, diffThemeName, isStreaming]}
        fallback={<pre {...props}>{children}</pre>}
      >
        <Suspense
          fallback={
            <pre {...props} className="invisible" aria-hidden>
              {children}
            </pre>
          }
        >
          <SuspenseShikiCodeBlock
            className={codeBlock.className}
            code={codeBlock.code}
            themeName={diffThemeName}
            isStreaming={isStreaming}
          />
        </Suspense>
      </RenderErrorBoundary>
    );
    if (language === "mermaid") {
      return (
        <MarkdownMermaidCodeBlock
          code={codeBlock.code}
          fenceTitle={fenceTitle}
          theme={resolvedTheme}
          isStreaming={isStreaming && !isClosedCodeFence(node, text, codeBlock.code)}
          onExpand={(src) => expandMedia({ images: [{ src, name: "Mermaid diagram" }], index: 0 })}
        >
          {highlightedCode}
        </MarkdownMermaidCodeBlock>
      );
    }
    return (
      <MarkdownCodeBlock
        code={codeBlock.code}
        language={language}
        fenceTitle={fenceTitle}
        theme={resolvedTheme}
        onRunShellCommand={
          onRunShellCommand && !isStreaming && isClosedCodeFence(node, text, codeBlock.code)
            ? onRunShellCommand
            : undefined
        }
        isStreaming={isStreaming}
      >
        {highlightedCode}
      </MarkdownCodeBlock>
    );
  },
} satisfies Components;

function ChatMarkdown({
  text,
  className,
  inline = false,
  lineBreaks = false,
  parseRawHtml = true,
  extraRemarkPlugins = EMPTY_REMARK_PLUGINS,
  ...props
}: ChatMarkdownProps) {
  const {
    componentState,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    closeLocalMediaPreview,
  } = useChatMarkdownState({ text, inline, ...props });
  const incrementalParsing =
    props.isStreaming === true &&
    extraRemarkPlugins.length === 0 &&
    /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
  const Root = inline ? "span" : "div";
  const bindMarkdownRef = (node: HTMLElement | null) => {
    markdownRef.current = node;
  };
  const remarkPlugins = [
    ...(lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS),
    ...extraRemarkPlugins,
    ...(incrementalParsing ? [createIncrementalMarkdownPlugin()] : []),
  ];
  if (componentState.mathEnabled)
    remarkPlugins.unshift([remarkMath, { singleDollarTextMath: true }]);

  return (
    <Root
      ref={bindMarkdownRef}
      className={cn(
        "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word]",
        !inline &&
          "text-sm leading-relaxed text-foreground/[calc(90%+var(--appearance-contrast-boost)/10)]",
        className,
      )}
      data-streaming={componentState.isStreaming ? "" : undefined}
      onCopy={handleCopy}
    >
      <ChatMarkdownRendererContext value={componentState}>
        <ChatMarkdownTextContext value={text}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={
              parseRawHtml
                ? CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS
                : CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS
            }
            skipHtml={false}
            components={CHAT_MARKDOWN_COMPONENTS}
            urlTransform={markdownUrlTransform}
          >
            {text}
          </ReactMarkdown>
        </ChatMarkdownTextContext>
      </ChatMarkdownRendererContext>
      {localMediaPreview ? (
        <ExpandedImageDialog preview={localMediaPreview} onClose={closeLocalMediaPreview} />
      ) : null}
    </Root>
  );
}

export default memo(ChatMarkdown);
