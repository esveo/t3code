import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  UserInsightsImportPreview,
  UserInsightsSnapshot,
} from "@t3tools/contracts";
import { HistoryIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useAtomCommand } from "~/state/use-atom-command";
import { importPreviewText, importProgressText } from "./userInsightsFormat";
import { userInsightsEnvironment } from "./userInsightsState";

/** How often the section reads the progress again while an import runs. */
const PROGRESS_REFRESH_MS = 3_000;

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

/**
 * Fork: user insights. Learning from messages typed before insights were on:
 * shows what an import would do and cost, then its progress.
 */
export function UserInsightsImport(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: UserInsightsSnapshot;
  readonly canOperate: boolean;
  readonly refresh: () => void;
}) {
  const { environmentId, snapshot, canOperate, refresh } = props;
  const act = useAtomCommand(userInsightsEnvironment.act, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<UserInsightsImportPreview | null>(null);
  const progress = snapshot.import ?? null;
  const running = progress?.state === "running";

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(refresh, PROGRESS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  const send = async (
    input: { readonly type: "import.preview" | "import.start" | "import.cancel" },
    failureTitle: string,
  ) => {
    setBusy(true);
    const result = await act({ environmentId, input });
    setBusy(false);
    reportFailure(failureTitle, result);
    return result._tag === "Success" ? result.value : null;
  };

  const progressText = importProgressText(progress);
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium text-foreground">Past messages</h4>
      <p>
        Learn from messages you typed in the last 30 days before user insights were on, up to the
        newest 300.
      </p>
      {progressText === null ? null : <p className="text-foreground">{progressText}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!canOperate || busy}
            onClick={() =>
              void send({ type: "import.cancel" }, "Could not cancel the import").then(refresh)
            }
          >
            Cancel
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={!canOperate || busy}
            onClick={() =>
              void send({ type: "import.preview" }, "Could not look for past messages").then(
                (result) => setPreview(result?.importPreview ?? null),
              )
            }
          >
            <HistoryIcon />
            Import past messages
          </Button>
        )}
      </div>
      <AlertDialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Import past messages?</AlertDialogTitle>
            <AlertDialogDescription>
              {preview === null ? null : importPreviewText(preview, snapshot.usage.dailyCapUsd)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            {preview !== null && preview.messages > 0 ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  void send({ type: "import.start" }, "Could not start the import").then(refresh);
                }}
              >
                Import
              </Button>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
