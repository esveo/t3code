import type { ForkNoteScope } from "@t3tools/contracts";
import { FolderIcon, GlobeIcon, type LucideIcon, MessageSquareIcon } from "lucide-react";

/** Fork: one icon per scope, shared by the Notes and Instructions tabs. */
export const FORK_NOTE_SCOPE_ICONS: Record<ForkNoteScope, LucideIcon> = {
  thread: MessageSquareIcon,
  project: FolderIcon,
  global: GlobeIcon,
};
