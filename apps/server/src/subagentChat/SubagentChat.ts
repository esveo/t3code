// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: server side of the subagent chat view in the Agents panel.
 *
 * The transcript is read from Claude's own subagent file instead of the event
 * store: it holds the full conversation (the adapter drops subagent narration
 * from the parent's events on purpose), survives restarts, and costs nothing
 * while no view is open. A subscription polls the file's size once a second
 * and sends only the lines appended since the last read.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  SUBAGENT_TRANSCRIPT_SNAPSHOT_MAX_LINES,
  SubagentChatError,
  type SubagentChatTarget,
  type SubagentTranscriptChunk,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import {
  createSubagentTranscriptConverter,
  splitTranscriptLines,
  type SubagentTranscriptSlice,
} from "./subagentTranscript.ts";

const POLL_INTERVAL = "1 second";
/** A tail read never pulls more than this per tick; the rest follows on the next ones. */
const READ_BYTE_CAP = 4 * 1024 * 1024;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Claude session id from a thread's persisted resume cursor. */
export function claudeSessionIdFromResumeCursor(cursor: unknown): string | undefined {
  if (!cursor || typeof cursor !== "object") return undefined;
  const { resume, sessionId } = cursor as { resume?: unknown; sessionId?: unknown };
  const candidate =
    typeof resume === "string" ? resume : typeof sessionId === "string" ? sessionId : undefined;
  return candidate && SESSION_ID_PATTERN.test(candidate) ? candidate : undefined;
}

function claudeConfigRoots(): ReadonlyArray<string> {
  const roots = [process.env.CLAUDE_CONFIG_DIR?.trim(), NodePath.join(NodeOS.homedir(), ".claude")];
  return [...new Set(roots.filter((root): root is string => !!root))];
}

/**
 * The transcript lives under the project directory Claude derived from the
 * session's cwd. Session ids are unique, so looking the session up across
 * project directories avoids re-deriving Claude's path mangling.
 */
async function findTranscriptFile(sessionId: string, agentId: string): Promise<string | null> {
  for (const root of claudeConfigRoots()) {
    const projectsDir = NodePath.join(root, "projects");
    let projects: string[];
    try {
      projects = await NodeFSP.readdir(projectsDir);
    } catch {
      continue;
    }
    for (const project of projects) {
      const candidate = NodePath.join(
        projectsDir,
        project,
        sessionId,
        "subagents",
        `agent-${agentId}.jsonl`,
      );
      try {
        if ((await NodeFSP.stat(candidate)).isFile()) return candidate;
      } catch {
        // Not this project.
      }
    }
  }
  return null;
}

interface TailState {
  convert: ReturnType<typeof createSubagentTranscriptConverter>;
  file: string | null;
  offset: number;
  rest: string;
  started: boolean;
  lastFound: boolean;
}

async function readAppended(
  state: TailState,
): Promise<SubagentTranscriptSlice & { truncated: boolean }> {
  const empty = { messages: [], activities: [], truncated: false };
  if (state.file === null) return empty;
  const handle = await NodeFSP.open(state.file, "r");
  try {
    const { size } = await handle.stat();
    if (size < state.offset) {
      // Rewritten from scratch; start over.
      state.offset = 0;
      state.rest = "";
      state.convert = createSubagentTranscriptConverter();
    }
    if (size === state.offset) return empty;
    // A long transcript opens at its end: the snapshot starts one cap before
    // the end and drops the partial line it lands in.
    const skipsHead = !state.started && size > READ_BYTE_CAP;
    if (skipsHead) state.offset = size - READ_BYTE_CAP;
    const length = Math.min(size - state.offset, READ_BYTE_CAP);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
    state.offset += bytesRead;
    let text = state.rest + buffer.subarray(0, bytesRead).toString("utf8");
    if (skipsHead) text = text.slice(text.indexOf("\n") + 1);
    const { lines, rest } = splitTranscriptLines(text);
    state.rest = rest;
    // Every line goes through the converter, so results find their calls, but
    // the snapshot keeps only the newest lines' rows.
    const keepFrom = state.started
      ? 0
      : Math.max(0, lines.length - SUBAGENT_TRANSCRIPT_SNAPSHOT_MAX_LINES);
    const slice: SubagentTranscriptSlice = { messages: [], activities: [] };
    lines.forEach((line, index) => {
      const converted = state.convert(line);
      if (index < keepFrom) return;
      slice.messages.push(...converted.messages);
      slice.activities.push(...converted.activities);
    });
    return { ...slice, truncated: skipsHead || keepFrom > 0 };
  } finally {
    await handle.close();
  }
}

const resolveSessionId = Effect.fn("subagentChat.resolveSessionId")(function* (
  target: SubagentChatTarget,
) {
  if (!AGENT_ID_PATTERN.test(target.agentId)) {
    return yield* new SubagentChatError({ message: "Invalid agent id." });
  }
  const directory = yield* ProviderSessionDirectory;
  const binding = yield* directory
    .getBinding(target.threadId)
    .pipe(
      Effect.mapError(() => new SubagentChatError({ message: "Thread session is unavailable." })),
    );
  return Option.isSome(binding)
    ? claudeSessionIdFromResumeCursor(binding.value.resumeCursor)
    : undefined;
});

export const subscribeSubagentTranscript = (target: SubagentChatTarget) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sessionId = yield* resolveSessionId(target);
      const state: TailState = {
        convert: createSubagentTranscriptConverter(),
        file: null,
        offset: 0,
        rest: "",
        started: false,
        lastFound: false,
      };
      const poll = Effect.tryPromise({
        try: async (): Promise<SubagentTranscriptChunk | null> => {
          if (state.file === null && sessionId !== undefined) {
            state.file = await findTranscriptFile(sessionId, target.agentId);
          }
          const { messages, activities, truncated } = await readAppended(state);
          const found = state.file !== null;
          const reset = !state.started;
          state.started = true;
          const empty = messages.length === 0 && activities.length === 0;
          if (!reset && empty && found === state.lastFound) return null;
          state.lastFound = found;
          return { reset, found, truncated, messages, activities };
        },
        catch: () => new SubagentChatError({ message: "Could not read the subagent transcript." }),
      });
      return Stream.tick(POLL_INTERVAL).pipe(
        Stream.mapEffect(() => poll),
        Stream.filter((chunk): chunk is SubagentTranscriptChunk => chunk !== null),
      );
    }),
  );

export const stopSubagent = Effect.fn("subagentChat.stop")(function* (target: SubagentChatTarget) {
  if (!AGENT_ID_PATTERN.test(target.agentId)) {
    return yield* new SubagentChatError({ message: "Invalid agent id." });
  }
  const providerService = yield* ProviderService;
  if (providerService.stopSubagent === undefined) {
    return yield* new SubagentChatError({ message: "This server cannot stop subagents." });
  }
  yield* providerService
    .stopSubagent({ threadId: target.threadId, agentId: target.agentId })
    .pipe(Effect.mapError((cause) => new SubagentChatError({ message: cause.message })));
  return {};
});
