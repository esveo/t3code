import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ForkInstructionsProvider,
  ForkInstructionsScope,
  ForkInstructionsSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { type KeyboardEvent, useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Toggle as ToggleGroupItem, ToggleGroup } from "~/components/ui/toggle-group";
import { useAtomCommand } from "~/state/use-atom-command";
import { forkInstructionsEnvironment } from "./forkInstructionsState";
import { useForkInstructionsDrafts, useForkInstructionsStore } from "./forkInstructionsStore";

const SCOPES: ReadonlyArray<{ value: ForkInstructionsScope; label: string }> = [
  { value: "project", label: "Project" },
  { value: "global", label: "Global" },
];

const PROVIDERS: ReadonlyArray<{ value: ForkInstructionsProvider; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const errorOf = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return {
    conflict:
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "ForkInstructionsConflictError",
    message: error instanceof Error ? error.message : "An error occurred.",
  };
};

/**
 * Fork: the Instructions tab, an editor for the instruction file the thread's
 * agent reads. The server picks the file; the tab reads it whenever the
 * thread, scope, provider or file changes, and saves with the version it read.
 */
export function ForkInstructionsPanel({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  if (!threadRef) return null;
  return <ForkInstructions key={scopedThreadKey(threadRef)} threadRef={threadRef} />;
}

function ForkInstructions({ threadRef }: { threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(threadRef);
  const { environmentId, threadId } = threadRef;
  const scope = useForkInstructionsStore((state) => state.scopeByThreadKey[threadKey] ?? "project");
  const storedProvider = useForkInstructionsStore((state) => state.providerByThreadKey[threadKey]);
  const setScope = useForkInstructionsStore((state) => state.setScope);
  const setProvider = useForkInstructionsStore((state) => state.setProvider);
  const canWrite = useAtomValue(forkInstructionsEnvironment.write.permissionAtom(environmentId));
  const read = useAtomCommand(forkInstructionsEnvironment.read, { reportFailure: false });
  const write = useAtomCommand(forkInstructionsEnvironment.write, { reportFailure: false });

  // An import picked in the switcher, for the scope and provider it was picked under.
  const [picked, setPicked] = useState<{ key: string; file: string } | null>(null);
  const targetKey = `${scope}:${storedProvider ?? ""}`;
  const file = picked?.key === targetKey ? picked.file : undefined;

  const [snapshot, setSnapshot] = useState<ForkInstructionsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ conflict: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Set when a newer target is asked for, so a late answer is dropped.
    let superseded = false;
    void read({ environmentId, input: { threadId, scope, provider: storedProvider, file } }).then(
      (result) => {
        if (superseded) return;
        if (result._tag === "Success") {
          setSnapshot(result.value);
          setLoadError(null);
          setSaveError(null);
        } else if (!isAtomCommandInterrupted(result)) {
          setSnapshot(null);
          setLoadError(errorOf(result).message);
        }
      },
    );
    return () => {
      superseded = true;
    };
  }, [read, environmentId, threadId, scope, storedProvider, file]);

  const draftKey = snapshot ? `${environmentId}:${snapshot.path}` : null;
  const draft = useForkInstructionsDrafts((state) => (draftKey ? state.drafts[draftKey] : null));
  const setDraft = useForkInstructionsDrafts((state) => state.setDraft);
  const content = draft?.content ?? snapshot?.content ?? "";
  const dirty = draft != null;
  // An edit kept from before the file changed on disk: saving it would overwrite that change.
  const stale = draft != null && snapshot !== null && draft.base !== snapshot.version;

  const edit = (next: string) => {
    if (!snapshot || !draftKey) return;
    setDraft(
      draftKey,
      next === snapshot.content && !stale
        ? null
        : { content: next, base: draft?.base ?? snapshot.version },
    );
  };

  const save = async (force: boolean) => {
    if (!snapshot || !draftKey || !draft || saving) return;
    setSaving(true);
    const result = await write({
      environmentId,
      input: {
        threadId,
        scope,
        provider: snapshot.provider,
        file: snapshot.path,
        content: draft.content,
        expectedVersion: draft.base,
        force,
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setDraft(draftKey, null);
      setSnapshot(result.value);
      setSaveError(null);
    } else if (!isAtomCommandInterrupted(result)) {
      setSaveError(errorOf(result));
    }
  };

  const discard = () => {
    if (draftKey) setDraft(draftKey, null);
    void read({ environmentId, input: { threadId, scope, provider: storedProvider, file } }).then(
      (result) => {
        if (result._tag !== "Success") return;
        setSnapshot(result.value);
        setSaveError(null);
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save(false);
    }
  };

  const provider = snapshot?.provider ?? storedProvider ?? null;
  const conflict = stale || saveError?.conflict === true;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 p-3 pb-2">
        <ToggleGroup
          className="w-full *:flex-1"
          value={[scope]}
          onValueChange={(next) => {
            const [selected] = next;
            if (selected === "project" || selected === "global") setScope(threadKey, selected);
          }}
        >
          {SCOPES.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup
          className="w-full *:flex-1"
          value={provider ? [provider] : []}
          onValueChange={(next) => {
            const [selected] = next;
            if (selected === "claude" || selected === "codex") setProvider(threadKey, selected);
          }}
        >
          {PROVIDERS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {loadError !== null ? (
        <div className="px-3 text-destructive-foreground text-sm">{loadError}</div>
      ) : snapshot === null ? null : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-xs">{snapshot.displayPath}</span>
            {!snapshot.exists ? (
              <Badge variant="info" size="sm">
                New, created on save
              </Badge>
            ) : null}
          </div>

          {snapshot.choices.length > 0 ? (
            <ToggleGroup
              className="w-full flex-wrap"
              value={[snapshot.path]}
              onValueChange={(next) => {
                const [selected] = next;
                if (selected) setPicked({ key: targetKey, file: selected });
              }}
            >
              {snapshot.choices.map((choice) => (
                <ToggleGroupItem key={choice.path} value={choice.path}>
                  {basename(choice.path)}
                  {choice.kind === "entry" ? " (imports)" : ""}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}

          {snapshot.alsoRead.map((hint) => (
            <p key={hint} className="text-muted-foreground text-xs">
              {hint}
            </p>
          ))}

          {conflict ? (
            <Alert variant="warning">
              <AlertDescription>
                {saveError?.conflict ? saveError.message : "The file changed since you edited it."}
              </AlertDescription>
              <AlertAction>
                <Button size="xs" variant="outline" onClick={discard}>
                  Reload
                </Button>
                <Button size="xs" variant="outline" onClick={() => void save(true)}>
                  Overwrite
                </Button>
              </AlertAction>
            </Alert>
          ) : saveError !== null ? (
            <Alert variant="error">
              <AlertDescription>{saveError.message}</AlertDescription>
            </Alert>
          ) : null}

          <textarea
            aria-label={snapshot.displayPath}
            className="min-h-0 flex-1 resize-none rounded-lg border border-input bg-background p-2 font-mono text-xs outline-none focus-visible:border-ring dark:bg-input/32"
            spellCheck={false}
            readOnly={!canWrite}
            value={content}
            onChange={(event) => edit(event.target.value)}
            onKeyDown={onKeyDown}
          />

          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-muted-foreground text-xs">
              {canWrite
                ? "Applies to new sessions; running agents keep what they started with."
                : "You can read this file but not save it on this environment."}
            </p>
            {dirty ? (
              <Button size="xs" variant="ghost" onClick={discard}>
                Discard
              </Button>
            ) : null}
            <Button
              size="xs"
              disabled={!canWrite || !dirty || saving}
              onClick={() => void save(false)}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
