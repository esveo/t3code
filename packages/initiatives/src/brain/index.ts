/**
 * The brain of an initiative: markdown pages in a git repository of its own,
 * provider-neutral so every agent reads the same thing. Three layers: the
 * steckbrief every thread gets at its start, an index of what exists, and
 * detail pages found by search. The coordinator's handoff is a page too.
 *
 * These are the pure rules; the server owns the repository and its one writer.
 */
import type { Initiative, InitiativeAuthor, InitiativeBrainLayer } from "@t3tools/contracts";

export const BRAIN_FILES = {
  steckbrief: "steckbrief.md",
  index: "index.md",
  handoff: "handoff.md",
} as const;

/** The directory detail pages live in. */
export const BRAIN_DETAIL_DIR = "details";

/**
 * A page path the brain accepts: relative, markdown, inside the repository and
 * never into git's own files. Returns the normalized path or why not.
 */
export function normalizeBrainPath(
  raw: string,
): { readonly path: string } | { readonly error: string } {
  const trimmed = raw
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (!trimmed) return { error: "The path is empty." };
  if (trimmed.startsWith("/"))
    return { error: "Give the path relative to the brain, for example details/api.md." };
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  if (parts.some((part) => part === ".." || part === ".")) {
    return { error: "The path must stay inside the brain." };
  }
  if (parts.some((part) => part.startsWith("."))) {
    return { error: "Hidden files and .git are not part of the brain." };
  }
  if (!/^[\p{L}\p{N}_ .-]+$/u.test(parts.join(""))) {
    return { error: "Use letters, digits, spaces, dots, dashes and underscores in page names." };
  }
  const path = parts.join("/");
  if (!path.toLowerCase().endsWith(".md"))
    return { error: "Brain pages are markdown files ending in .md." };
  return { path };
}

export function layerOfPath(path: string): InitiativeBrainLayer {
  if (path === BRAIN_FILES.steckbrief) return "steckbrief";
  if (path === BRAIN_FILES.index) return "index";
  if (path === BRAIN_FILES.handoff) return "handoff";
  return "detail";
}

/** The page's first heading, or its file name. */
export function titleOfPage(path: string, markdown: string): string {
  const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(markdown);
  if (heading?.[1]) return heading[1].trim();
  const name = path.split("/").at(-1) ?? path;
  return name.replace(/\.md$/i, "");
}

/** The pages a new brain starts with. */
export function initialBrainPages(
  initiative: Pick<Initiative, "title" | "goalText">,
): ReadonlyArray<{ readonly path: string; readonly markdown: string }> {
  return [
    {
      path: BRAIN_FILES.steckbrief,
      markdown: [
        `# ${initiative.title}`,
        "",
        initiative.goalText.trim() || "_Noch kein Ziel formuliert._",
        "",
      ].join("\n"),
    },
    {
      path: BRAIN_FILES.index,
      markdown: [
        "# Index",
        "",
        "One line per page: `- [Title](details/page.md) — what it holds`.",
        "",
      ].join("\n"),
    },
    {
      path: BRAIN_FILES.handoff,
      markdown: renderHandoff({ openTasks: [], lastResults: [], nextStep: "" }),
    },
  ];
}

export interface Handoff {
  readonly openTasks: ReadonlyArray<string>;
  /** What threads reported, quoted as data. */
  readonly lastResults: ReadonlyArray<string>;
  readonly nextStep: string;
}

const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/**
 * The coordinator's handoff: what a fresh coordinator needs to pick the work
 * up without the old chat. Results are quoted: they are what threads
 * reported, not instructions.
 */
export function renderHandoff(handoff: Handoff): string {
  const lines = ["# Übergabe", "", "## Offene Tasks", ""];
  if (handoff.openTasks.length === 0) lines.push("_Keine._");
  for (const task of handoff.openTasks) lines.push(`- ${task.trim()}`);
  lines.push("", "## Letzte Ergebnisse", "");
  if (handoff.lastResults.length === 0) lines.push("_Keine._");
  for (const result of handoff.lastResults) lines.push(quote(result), "");
  lines.push("", "## Nächster Schritt", "", handoff.nextStep.trim() || "_Offen._", "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** A git identity for an author; the address only has to be stable. */
export function gitIdentityOf(author: InitiativeAuthor): {
  readonly name: string;
  readonly email: string;
} {
  const slug = author.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  return { name: author, email: `${slug}@initiatives.t3.local` };
}

/** Text for a start prompt, cut at a line end when it is too long. */
export function clampForPrompt(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text.trim();
  const cut = text.slice(0, maxLength);
  const lineEnd = cut.lastIndexOf("\n");
  return `${(lineEnd > maxLength / 2 ? cut.slice(0, lineEnd) : cut).trim()}\n… (cut; read the full page with brain_read)`;
}

/** Why an agent may not write this page, or null. A person's correction wins. */
export function agentWriteBlocker(
  page: { readonly lockedBy: InitiativeAuthor | null } | null,
  author: InitiativeAuthor,
): string | null {
  if (!page?.lockedBy || page.lockedBy === author || author.startsWith("person:")) return null;
  return "A person corrected this page, so agents leave it alone. Ask the user if it needs to change.";
}
