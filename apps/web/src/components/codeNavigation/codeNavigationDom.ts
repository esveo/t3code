/**
 * Fork: DOM work of code navigation inside Pierre's shadow roots — the link
 * underline (CSS Custom Highlight API, so no re-render), the character under
 * the pointer, and finding a rendered line to flash.
 */
import { characterIndexAt, type DiffSide } from "./codeNavigation.logic";

const LINK_HIGHLIGHT = "esveo-code-nav-link";
const FLASH_ATTRIBUTE = "data-esveo-code-nav-flash";
const FLASH_MS = 1400;

/** Goes into every viewer's shadow root: `::highlight()` only styles ranges of its own tree. */
export const CODE_NAVIGATION_UNSAFE_CSS = `
::highlight(${LINK_HIGHLIGHT}) {
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

[${FLASH_ATTRIBUTE}] {
  --diffs-line-bg: color-mix(in srgb, var(--code-background) 70%, var(--diffs-modified-base)) !important;
}
`;

let linkHighlight: Highlight | null = null;
let linkCursorElement: HTMLElement | null = null;

const highlightsSupported = () => typeof CSS !== "undefined" && "highlights" in CSS;

/** Underlines columns [start, end) of a rendered line and gives the token a pointer cursor. */
export function showLink(lineElement: HTMLElement, start: number, end: number) {
  const range = rangeForColumns(lineElement, start, end);
  if (!range) return clearLink();
  if (highlightsSupported()) {
    linkHighlight ??= new Highlight();
    linkHighlight.clear();
    linkHighlight.add(range);
    CSS.highlights.set(LINK_HIGHLIGHT, linkHighlight);
  }
  const container = range.startContainer.parentElement;
  if (container !== linkCursorElement) {
    if (linkCursorElement) linkCursorElement.style.cursor = "";
    linkCursorElement = container;
  }
  if (linkCursorElement) linkCursorElement.style.cursor = "pointer";
}

export function clearLink() {
  linkHighlight?.clear();
  if (linkCursorElement) linkCursorElement.style.cursor = "";
  linkCursorElement = null;
}

/** Pierre renders each token as a span whose `data-char` is its first column. */
function tokenSpans(lineElement: HTMLElement) {
  return lineElement.querySelectorAll<HTMLElement>("[data-char]");
}

function rangeForColumns(lineElement: HTMLElement, start: number, end: number): Range | null {
  let startPoint: [Text, number] | null = null;
  let endPoint: [Text, number] | null = null;
  for (const span of tokenSpans(lineElement)) {
    const first = Number(span.dataset.char);
    const text = span.firstChild;
    if (!(text instanceof Text) || Number.isNaN(first)) continue;
    const last = first + text.length;
    if (!startPoint && start >= first && start < last) startPoint = [text, start - first];
    if (end > first && end <= last) {
      endPoint = [text, end - first];
      break;
    }
  }
  if (!startPoint || !endPoint) return null;
  const range = new Range();
  range.setStart(...startPoint);
  range.setEnd(...endPoint);
  return range;
}

/** The line row a token is rendered in. */
export const lineElementOf = (token: HTMLElement) => token.closest<HTMLElement>("[data-line]");

/** The column in its line of the character under the pointer, inside `token`. */
export function columnAtPoint(token: HTMLElement, lineCharStart: number, x: number, y: number) {
  const text = token.firstChild;
  if (!(text instanceof Text) || text.length === 0) return lineCharStart;
  const root = token.getRootNode();
  const caret = document.caretPositionFromPoint?.(
    x,
    y,
    root instanceof ShadowRoot ? { shadowRoots: [root] } : undefined,
  );
  if (!caret || caret.offsetNode !== text) return lineCharStart;
  let pointerIsLeft = false;
  if (caret.offset < text.length) {
    const character = new Range();
    character.setStart(text, caret.offset);
    character.setEnd(text, caret.offset + 1);
    pointerIsLeft = x < character.getBoundingClientRect().left;
  } else {
    pointerIsLeft = true;
  }
  return lineCharStart + characterIndexAt(caret.offset, text.length, pointerIsLeft);
}

function sideOfLine(lineElement: HTMLElement): DiffSide {
  const type = lineElement.dataset.lineType;
  if (type === "change-deletion") return "deletions";
  if (type === "change-addition") return "additions";
  return lineElement.closest("[data-code]")?.hasAttribute("data-deletions")
    ? "deletions"
    : "additions";
}

/** A rendered line of one viewer; unified context rows carry the old number as `data-alt-line`. */
function findLine(root: ShadowRoot, side: DiffSide | null, line: number) {
  for (const element of root.querySelectorAll<HTMLElement>(
    `[data-line="${line}"], [data-alt-line="${line}"]`,
  )) {
    if (side === null) return element;
    const own = element.dataset.line === String(line);
    const elementSide = sideOfLine(element);
    if (own && elementSide === side) return element;
    // Unified view: a context row shows the old line number as its alternate.
    if (!own && side === "deletions" && element.dataset.lineType?.startsWith("context")) {
      return element;
    }
  }
  return null;
}

function viewerRoots(container: HTMLElement) {
  return [...container.querySelectorAll("diffs-container")].flatMap((host) =>
    host.shadowRoot ? [host.shadowRoot] : [],
  );
}

/**
 * Briefly highlights a line once the viewer has rendered it after a scroll.
 * `title` picks the file's viewer in a multi-file diff.
 */
export function flashLine(
  container: HTMLElement,
  title: string | null,
  side: DiffSide | null,
  line: number,
) {
  let frames = 0;
  const attempt = () => {
    for (const root of viewerRoots(container)) {
      if (title !== null && root.querySelector("[data-title]")?.textContent !== title) continue;
      const element = findLine(root, side, line);
      if (!element) continue;
      element.setAttribute(FLASH_ATTRIBUTE, "");
      window.setTimeout(() => element.removeAttribute(FLASH_ATTRIBUTE), FLASH_MS);
      return;
    }
    // The viewer renders the scrolled-to window over the next frames; give up after half a second.
    if (++frames < 30) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
